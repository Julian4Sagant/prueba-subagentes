import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.text.Normalizer;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Entrada automática del tramo de planificación.
 *
 * No decide nada del flujo: las reglas están en ORQUESTACION.md y CARRILES.md, y las aplica
 * Claude Code como orquestador. Este programa recibe los eventos (pedidos y decisiones de
 * gate), corre Claude Code sin interfaz en el proyecto y retoma la misma sesión con cada
 * decisión. Sabe en qué quedó cada pedido por el bloque de estado que el orquestador escribe
 * al devolver el control (ver "Bloque de estado al devolver el control" en ORQUESTACION.md).
 *
 * Uso (Java 17 o más, sin compilar aparte):
 *   java Orquestador.java --proyecto C:/DEV/prueba-agentes [--bandeja bandeja] [--vigilar]
 *
 * Opciones:
 *   --proyecto <dir>     proyecto con los agentes instalados (obligatorio)
 *   --bandeja <dir>      carpeta de eventos (por defecto, ./bandeja)
 *   --vigilar            queda esperando archivos nuevos (Ctrl+C para salir)
 *   --claude <comando>   cómo lanzar Claude Code (por defecto claude.cmd en Windows, claude en
 *                        el resto); se separa por espacios, por ejemplo "node claude-falso.js"
 *   --permisos <json>    settings de Claude Code con los permisos de la corrida (por defecto,
 *                        bandeja/claude-settings.json, que se crea con una lista base)
 *   --modelo <modelo>    modelo del orquestador (por defecto, el de la configuración)
 *   --presupuesto <usd>  tope de gasto por corrida (por defecto 30)
 *   --timeout <minutos>  tope de duración por corrida (por defecto 180)
 *
 * Bandeja:
 *   entrada/      un .txt por pedido; el nombre es el id. Cabecera opcional "autor: ..."
 *   decisiones/   un .txt por respuesta: cabeceras "pedido:", "gate:", "decision:" y, debajo,
 *                 el comentario (puede ocupar varias líneas)
 *   gates/        lo que devolvió el orquestador en cada corrida, para leer y decidir
 *   estado/       un .properties por pedido: sesión, en qué gate espera, costo
 *   registro/     la salida cruda de cada corrida
 *   procesados/ y descartados/   los eventos ya leídos
 */
public class Orquestador {

    static final List<String> ESPERAS = List.of(
            "VALIDAR_BASELINE", "APROBAR_SPEC", "APROBAR_DISENO", "CONFIRMAR_YA_CUMPLE", "ESCALADA", "NADA");

    /**
     * Permisos base: lo que usan los agentes y el orquestador en las corridas de prueba.
     * Incluye `javac` y `java` para que el arquitecto pueda compilar y correr un programa de
     * prueba fuera de Maven (su prompt lo permite, levantando la app en un puerto propio y
     * bajándola al terminar). El hook `sin-escritura.js` sigue bloqueando git; editá el archivo
     * generado si una corrida necesita más.
     */
    static final List<String> PERMISOS_BASE = List.of(
            "Read", "Edit", "Write", "Glob", "Grep", "Agent", "Task", "Skill",
            "Bash(openspec:*)", "Bash(mvn:*)", "Bash(./mvnw:*)", "Bash(java:*)", "Bash(javac:*)",
            "Bash(node:*)", "Bash(curl:*)", "Bash(grep:*)", "Bash(ls:*)", "Bash(cat:*)",
            "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(diff:*)", "Bash(sed -n:*)",
            "Bash(od:*)", "Bash(mkdir:*)", "Bash(cp:*)", "Bash(echo:*)", "Bash(unzip -l:*)",
            "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
            "PowerShell(openspec:*)", "PowerShell(./mvnw:*)", "PowerShell(mvn:*)",
            "PowerShell(javac:*)", "PowerShell(java:*)",
            "PowerShell(Get-Content:*)", "PowerShell(Get-ChildItem:*)", "PowerShell(Select-String:*)");

    // ---------------------------------------------------------------- Configuración

    record Config(Path proyecto, Path bandeja, boolean vigilar, List<String> claude, Path permisos,
                  String modelo, double presupuesto, long timeoutMin) {}

    // ---------------------------------------------------------------- Estado de un pedido

    static final class Estado {
        final Path archivo;
        String id = "", autor = "", sesion = "", espera = "", change = "", carril = "", motivo = "";
        int corridas = 0;
        double costo = 0;

        Estado(Path archivo) { this.archivo = archivo; }

        static Estado cargar(Path archivo) throws IOException {
            Estado e = new Estado(archivo);
            Properties p = new Properties();
            try (var r = Files.newBufferedReader(archivo, StandardCharsets.UTF_8)) { p.load(r); }
            e.id = p.getProperty("id", "");
            e.autor = p.getProperty("autor", "");
            e.sesion = p.getProperty("sesion", "");
            e.espera = p.getProperty("espera", "");
            e.change = p.getProperty("change", "");
            e.carril = p.getProperty("carril", "");
            e.motivo = p.getProperty("motivo", "");
            e.corridas = Integer.parseInt(p.getProperty("corridas", "0"));
            e.costo = Double.parseDouble(p.getProperty("costo", "0"));
            return e;
        }

        void guardar() throws IOException {
            Properties p = new Properties();
            p.setProperty("id", id);
            p.setProperty("autor", autor);
            p.setProperty("sesion", sesion);
            p.setProperty("espera", espera);
            p.setProperty("change", change);
            p.setProperty("carril", carril);
            p.setProperty("motivo", motivo);
            p.setProperty("corridas", String.valueOf(corridas));
            p.setProperty("costo", String.format(Locale.ROOT, "%.4f", costo));
            p.setProperty("actualizado", LocalDateTime.now().withNano(0).toString());
            try (var w = Files.newBufferedWriter(archivo, StandardCharsets.UTF_8)) { p.store(w, "Estado del pedido"); }
        }
    }

    // ---------------------------------------------------------------- Programa

    final Config cfg;

    Orquestador(Config cfg) { this.cfg = cfg; }

    Path dir(String nombre) { return cfg.bandeja().resolve(nombre); }

    void prepararBandeja() throws IOException {
        for (String d : List.of("entrada", "decisiones", "gates", "estado", "registro", "procesados", "descartados"))
            Files.createDirectories(dir(d));
    }

    void procesar() throws IOException, InterruptedException {
        for (Path f : txt("entrada")) mover(f, nuevoPedido(f));
        for (Path f : txt("decisiones")) mover(f, decision(f));
    }

    /** Primera entrada: un pedido nuevo. Corre /pedido hasta el primer punto de parada. */
    boolean nuevoPedido(Path f) throws IOException, InterruptedException {
        String id = idSeguro(f.getFileName().toString().replaceFirst("\\.txt$", ""));
        Map<String, String> cab = new LinkedHashMap<>();
        String texto = separarCabecera(Files.readString(f, StandardCharsets.UTF_8), cab, List.of("autor")).trim();
        System.out.println("\n>> Pedido " + id + (cab.containsKey("autor") ? " de " + cab.get("autor") : ""));
        if (id.isEmpty() || texto.isEmpty()) return descartar("el pedido no tiene id o está vacío");
        Path archivoEstado = dir("estado").resolve(id + ".properties");
        if (Files.exists(archivoEstado)) return descartar("ya hay un pedido " + id + " en curso o terminado");

        Estado e = new Estado(archivoEstado);
        e.id = id;
        e.autor = cab.getOrDefault("autor", "");
        e.espera = "CORRIENDO";
        e.guardar();
        correr(e, "/pedido " + texto);
        return true;
    }

    /** Segunda entrada: la respuesta a un gate. Retoma la misma sesión. */
    boolean decision(Path f) throws IOException, InterruptedException {
        Map<String, String> cab = new LinkedHashMap<>();
        String cuerpo = separarCabecera(Files.readString(f, StandardCharsets.UTF_8), cab,
                List.of("pedido", "gate", "decision", "comentario", "autor")).trim();
        String id = idSeguro(cab.getOrDefault("pedido", ""));
        String gate = cab.getOrDefault("gate", "").trim().toUpperCase(Locale.ROOT);
        String decision = cab.getOrDefault("decision", "").trim().toLowerCase(Locale.ROOT);
        String comentario = (cab.getOrDefault("comentario", "") + "\n" + cuerpo).trim();
        System.out.println("\n>> Decisión " + gate + " sobre " + id + ": " + decision);

        Path archivoEstado = dir("estado").resolve(id + ".properties");
        if (id.isEmpty() || !Files.exists(archivoEstado)) return descartar("no hay ningún pedido " + id);
        Estado e = Estado.cargar(archivoEstado);
        if (!e.espera.equals(gate)) return descartar("el pedido espera " + e.espera + ", no " + gate);
        if (e.sesion.isEmpty()) return descartar("el pedido no tiene una sesión para retomar");

        String mensaje;
        if (decision.startsWith("aprob") || decision.startsWith("confirm")) {
            mensaje = "Decisión del gate " + gate + ": aprobada" + (comentario.isEmpty() ? "" : ". " + comentario);
        } else if (decision.startsWith("rechaz")) {
            if (comentario.isEmpty()) return descartar("un rechazo tiene que traer un comentario");
            mensaje = "Decisión del gate " + gate + ": rechazada: " + comentario;
        } else if (decision.startsWith("respu")) {
            if (comentario.isEmpty()) return descartar("una respuesta tiene que traer texto");
            mensaje = "Decisión del gate " + gate + ": " + comentario;
        } else {
            return descartar("decision tiene que ser aprobada, rechazada o respuesta");
        }
        e.espera = "CORRIENDO";
        e.guardar();
        correr(e, mensaje);
        return true;
    }

    /** Corre Claude Code (nuevo o retomando la sesión) y deja el gate y el estado escritos. */
    void correr(Estado e, String prompt) throws IOException, InterruptedException {
        e.corridas++;
        List<String> cmd = new ArrayList<>(cfg.claude());
        cmd.addAll(List.of("-p", "--output-format", "json",
                "--permission-mode", "acceptEdits",
                "--settings", cfg.permisos().toAbsolutePath().toString(),
                "--max-budget-usd", String.format(Locale.ROOT, "%.2f", cfg.presupuesto())));
        if (!e.sesion.isEmpty()) cmd.addAll(List.of("--resume", e.sesion));
        if (cfg.modelo() != null) cmd.addAll(List.of("--model", cfg.modelo()));

        System.out.println("   Corrida " + e.corridas + (e.sesion.isEmpty() ? " (sesión nueva)" : " (sesión " + e.sesion + ")")
                + ". Puede tardar bastante.");
        ProcessBuilder pb = new ProcessBuilder(cmd).directory(cfg.proyecto().toFile());
        Process p = pb.start();
        try (OutputStream in = p.getOutputStream()) { in.write(prompt.getBytes(StandardCharsets.UTF_8)); }
        var salida = leerEnSegundoPlano(p.getInputStream());
        var errores = leerEnSegundoPlano(p.getErrorStream());
        boolean termino = p.waitFor(cfg.timeoutMin(), TimeUnit.MINUTES);
        if (!termino) p.destroyForcibly();
        salida.join();
        errores.join();
        String out = salida.texto(), err = errores.texto();
        String base = e.id + "-" + e.corridas;
        Files.writeString(dir("registro").resolve(base + ".json"), out, StandardCharsets.UTF_8);
        if (!err.isBlank()) Files.writeString(dir("registro").resolve(base + ".stderr.txt"), err, StandardCharsets.UTF_8);

        String resultado = "";
        List<String> negados = new ArrayList<>();
        double costo = 0;
        String problema = null;
        Object json = null;
        try { json = out.isBlank() ? null : Json.parse(out.trim()); } catch (RuntimeException ex) { /* queda null */ }
        if (!termino) {
            problema = "la corrida superó " + cfg.timeoutMin() + " minutos y se cortó";
        } else if (!(json instanceof Map)) {
            problema = "Claude Code no devolvió JSON (código " + p.exitValue() + "); mirá registro/" + base + "*";
        } else {
            Map<?, ?> m = (Map<?, ?>) json;
            if (m.get("session_id") instanceof String s && !s.isEmpty()) e.sesion = s;
            if (m.get("total_cost_usd") instanceof Number n) costo = n.doubleValue();
            if (m.get("result") instanceof String r) resultado = r;
            if (m.get("permission_denials") instanceof List<?> l)
                for (Object o : l) negados.add(o instanceof Map<?, ?> d ? String.valueOf(d.get("tool_name")) + " " + d.get("tool_input") : String.valueOf(o));
            if (Boolean.TRUE.equals(m.get("is_error")))
                problema = "Claude Code terminó con error (" + m.get("subtype") + ")";
        }
        e.costo += costo;

        Map<?, ?> bloque = problema == null ? bloqueDeEstado(resultado) : null;
        if (problema == null && bloque == null) problema = "el orquestador no cerró con el bloque de estado";
        if (problema != null) {
            e.espera = "ESCALADA";
            e.motivo = problema;
        } else {
            String espera = String.valueOf(bloque.get("espera"));
            e.espera = ESPERAS.contains(espera) ? espera : "ESCALADA";
            e.motivo = ESPERAS.contains(espera) ? texto(bloque.get("motivo")) : "espera desconocida en el bloque de estado: " + espera;
            e.change = texto(bloque.get("change"));
            e.carril = texto(bloque.get("carril"));
        }
        e.guardar();

        Path gate = dir("gates").resolve(base + ".md");
        Files.writeString(gate, armarGate(e, base, costo, negados, resultado), StandardCharsets.UTF_8);
        System.out.println("   Espera: " + e.espera + (e.motivo.isEmpty() ? "" : " (" + e.motivo + ")"));
        System.out.println(String.format(Locale.ROOT, "   Costo estimado (precio de lista): US$ %.2f (acumulado US$ %.2f)", costo, e.costo));
        if (!negados.isEmpty()) System.out.println("   Permisos negados: " + negados.size() + ", detalle en el gate");
        System.out.println("   Para leer: " + gate);
    }

    String armarGate(Estado e, String base, double costo, List<String> negados, String resultado) {
        StringBuilder sb = new StringBuilder();
        sb.append("# ").append(e.id).append(", corrida ").append(e.corridas).append("\n\n");
        sb.append("- Espera: **").append(e.espera).append("**").append(e.motivo.isEmpty() ? "" : " (" + e.motivo + ")").append("\n");
        sb.append("- Change: ").append(e.change.isEmpty() ? "-" : e.change)
          .append(" | Carril: ").append(e.carril.isEmpty() ? "-" : e.carril).append("\n");
        sb.append(String.format(Locale.ROOT, "- Costo estimado (precio de lista): US$ %.2f (acumulado US$ %.2f) | Sesión: %s%n", costo, e.costo, e.sesion));
        if (!negados.isEmpty()) {
            sb.append("- **Permisos negados** (sumalos a ").append(cfg.permisos().getFileName()).append(" si hacían falta):\n");
            for (String n : negados) sb.append("  - `").append(n.replace("`", "'")).append("`\n");
        }
        if (!e.espera.equals("NADA")) {
            sb.append("\nPara responder, creá un .txt en `decisiones/`:\n\n```text\n")
              .append("pedido: ").append(e.id).append("\n")
              .append("gate: ").append(e.espera).append("\n");
            if (e.espera.equals("ESCALADA")) sb.append("decision: respuesta\n");
            else sb.append("decision: aprobada        (o rechazada)\n");
            sb.append("<comentario, en una o varias líneas; obligatorio si rechazás>\n```\n");
        }
        sb.append("\n---\n\n").append(resultado.isEmpty() ? "_(sin texto; mirá registro/" + base + "*)_" : resultado).append("\n");
        return sb.toString();
    }

    // ---------------------------------------------------------------- Utilidades

    /** El último bloque ```json``` del texto con "orquestador": "estado". */
    static Map<?, ?> bloqueDeEstado(String texto) {
        Matcher m = Pattern.compile("```json\\s*\\n(.*?)\\n\\s*```", Pattern.DOTALL).matcher(texto);
        Map<?, ?> ultimo = null;
        while (m.find()) {
            try {
                Object o = Json.parse(m.group(1).trim());
                if (o instanceof Map<?, ?> mm && "estado".equals(mm.get("orquestador"))) ultimo = mm;
            } catch (RuntimeException ex) { /* no es JSON válido: se ignora */ }
        }
        return ultimo;
    }

    static String texto(Object o) { return o == null ? "" : String.valueOf(o); }

    static boolean descartar(String motivo) {
        System.out.println("   Descartado: " + motivo + ".");
        return false;
    }

    List<Path> txt(String carpeta) throws IOException {
        try (Stream<Path> s = Files.list(dir(carpeta))) {
            return s.filter(x -> x.toString().endsWith(".txt")).sorted().toList();
        }
    }

    void mover(Path f, boolean procesado) throws IOException {
        Path destino = dir(procesado ? "procesados" : "descartados").resolve(f.getFileName());
        Files.move(f, destino, StandardCopyOption.REPLACE_EXISTING);
    }

    static String idSeguro(String id) {
        String sinAcentos = Normalizer.normalize(id, Normalizer.Form.NFD).replaceAll("\\p{M}", "");
        return sinAcentos.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
    }

    /** Lee líneas "clave: valor" del principio (solo claves conocidas) y devuelve el resto. */
    static String separarCabecera(String contenido, Map<String, String> cab, List<String> claves) {
        String[] lineas = contenido.replace("\uFEFF", "").replace("\r", "").split("\n", -1);
        int i = 0;
        for (; i < lineas.length; i++) {
            int dos = lineas[i].indexOf(':');
            if (dos < 0) break;
            String clave = lineas[i].substring(0, dos).trim().toLowerCase(Locale.ROOT);
            if (!claves.contains(clave)) break;
            cab.put(clave, lineas[i].substring(dos + 1).trim());
        }
        return String.join("\n", Arrays.copyOfRange(lineas, i, lineas.length));
    }

    static final class Lector extends Thread {
        final InputStream in;
        final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        Lector(InputStream in) { this.in = in; setDaemon(true); }
        @Override public void run() { try { in.transferTo(buf); } catch (IOException ignored) { } }
        String texto() { return buf.toString(StandardCharsets.UTF_8); }
    }

    static Lector leerEnSegundoPlano(InputStream in) {
        Lector l = new Lector(in);
        l.start();
        return l;
    }

    void escribirPermisosBase() throws IOException {
        StringBuilder sb = new StringBuilder("{\n  \"permissions\": {\n    \"allow\": [\n");
        for (int i = 0; i < PERMISOS_BASE.size(); i++)
            sb.append("      \"").append(PERMISOS_BASE.get(i)).append("\"").append(i < PERMISOS_BASE.size() - 1 ? ",\n" : "\n");
        sb.append("    ]\n  }\n}\n");
        Files.writeString(cfg.permisos(), sb.toString(), StandardCharsets.UTF_8);
        System.out.println("Permisos base escritos en " + cfg.permisos() + "; editalos si una corrida necesita más.");
    }

    /** Parser JSON mínimo: objetos, arrays, textos, números, true, false y null. */
    static final class Json {
        final String s;
        int i = 0;
        Json(String s) { this.s = s; }

        static Object parse(String s) {
            Json j = new Json(s);
            Object v = j.valor();
            j.blancos();
            if (j.i != s.length()) throw new IllegalArgumentException("sobra texto en la posición " + j.i);
            return v;
        }

        void blancos() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

        Object valor() {
            blancos();
            if (i >= s.length()) throw new IllegalArgumentException("JSON incompleto");
            char c = s.charAt(i);
            if (c == '{') return objeto();
            if (c == '[') return array();
            if (c == '"') return cadena();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int ini = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            if (ini == i) throw new IllegalArgumentException("carácter inesperado en la posición " + i);
            return Double.parseDouble(s.substring(ini, i));
        }

        Map<String, Object> objeto() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++;
            blancos();
            if (s.charAt(i) == '}') { i++; return m; }
            while (true) {
                blancos();
                String k = cadena();
                blancos();
                if (s.charAt(i++) != ':') throw new IllegalArgumentException("falta ':' en la posición " + i);
                m.put(k, valor());
                blancos();
                char c = s.charAt(i++);
                if (c == '}') return m;
                if (c != ',') throw new IllegalArgumentException("falta ',' en la posición " + i);
            }
        }

        List<Object> array() {
            List<Object> l = new ArrayList<>();
            i++;
            blancos();
            if (s.charAt(i) == ']') { i++; return l; }
            while (true) {
                l.add(valor());
                blancos();
                char c = s.charAt(i++);
                if (c == ']') return l;
                if (c != ',') throw new IllegalArgumentException("falta ',' en la posición " + i);
            }
        }

        String cadena() {
            if (s.charAt(i) != '"') throw new IllegalArgumentException("se esperaba texto en la posición " + i);
            i++;
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n' -> sb.append('\n');
                    case 't' -> sb.append('\t');
                    case 'r' -> sb.append('\r');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'u' -> { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                    default -> sb.append(e);
                }
            }
        }
    }

    // ---------------------------------------------------------------- main

    public static void main(String[] args) throws Exception {
        Path proyecto = null, bandeja = Path.of("bandeja"), permisos = null;
        boolean vigilar = false;
        boolean windows = System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win");
        List<String> claude = List.of(windows ? "claude.cmd" : "claude");
        // El orquestador (leer, verificar, aplicar reglas fijas, escribir el gate) no necesita
        // Opus: Sonnet cuesta varias veces menos por token. Los subagentes que sí lo necesitan
        // (arqueólogo, arquitecto) lo conservan por su frontmatter. Cambialo con --modelo.
        String modelo = "sonnet";
        double presupuesto = 30;
        long timeout = 180;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--proyecto" -> proyecto = Path.of(args[++i]);
                case "--bandeja" -> bandeja = Path.of(args[++i]);
                case "--vigilar" -> vigilar = true;
                case "--claude" -> claude = List.of(args[++i].trim().split("\\s+"));
                case "--permisos" -> permisos = Path.of(args[++i]);
                case "--modelo" -> modelo = args[++i];
                case "--presupuesto" -> presupuesto = Double.parseDouble(args[++i]);
                case "--timeout" -> timeout = Long.parseLong(args[++i]);
                default -> { System.out.println("Opción desconocida: " + args[i]); System.exit(2); }
            }
        }
        if (proyecto == null) { System.out.println("Falta --proyecto <dir>."); System.exit(2); }
        for (String f : List.of("ORQUESTACION.md", "CARRILES.md", ".claude/commands/pedido.md")) {
            if (!Files.exists(proyecto.resolve(f))) {
                System.out.println("En " + proyecto + " falta " + f + ": instalá los agentes primero (scripts/install.ps1).");
                System.exit(2);
            }
        }
        boolean permisosPorDefecto = permisos == null;
        if (permisosPorDefecto) permisos = bandeja.resolve("claude-settings.json");

        Orquestador o = new Orquestador(new Config(proyecto, bandeja, vigilar, claude, permisos, modelo, presupuesto, timeout));
        o.prepararBandeja();
        if (permisosPorDefecto && !Files.exists(permisos)) o.escribirPermisosBase();
        if (!Files.exists(permisos)) { System.out.println("No existe " + permisos + "."); System.exit(2); }

        System.out.println("Proyecto " + proyecto.toAbsolutePath() + " | bandeja " + bandeja.toAbsolutePath()
                + (vigilar ? " | vigilando cada 5 s (Ctrl+C para salir)" : ""));
        do {
            o.procesar();
            if (vigilar) Thread.sleep(5000);
        } while (vigilar);
    }
}
