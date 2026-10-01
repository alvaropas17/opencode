# Handoff — opencode v2.0.20 vs instalación actual (colisión/consolidación)

> Continúa desde aquí. Windows / PowerShell 5.1. Responde en español, con progreso `[n/N]`.
> Nada destructivo sin confirmación. Para más detalle del update ya hecho, ver más abajo.

## Estado: qué YA está hecho (NO repetir)

### Repo A (actualizado) — `C:\Users\alvar\dev\opencode-src` (git, **SHALLOW**)
- Rama `agents-instruction-dedup` @ HEAD **`40c38feca3`**.
- Base: tag **`v2.0.20` = `84c9be93a5`**. Encima, **8 commits locales** (7 originales + 1 WIP).
- `bun run --cwd packages/cli build` → **OK**. `package.json` = **2.0.20**.
- Binario: `packages\cli\dist\cli-windows-x64\bin\opencode.exe` (reporta `v0.0.0-agents-instruction-dedup-...`).
- **Backup**: `C:\Users\alvar\dev\opencode-src-backup-20260930-140750.bundle`
  (+ carpeta `C:\Users\alvar\dev\opencode-src-backup-20260930-140750\`).
  SHA256 bundle: `9627D558C453178C819EDB7831F23DD1EAF3B7425B5A7B7F7D4195577FAA02BB`.
- Rollback: `git reset --hard 5bcf6b7` (requiere OK) o clonar desde el bundle.
- Notas: el repo es shallow (frontera en `cd9a14a`, tag `v2.0.18`). `cd9a14a` NO es ancestro de
  v2.0.20; el ancestro común real es `041885d`. bun global pasó de 1.3.14 → **1.4.2** (el build lo exige).

### Parches locales en opencode-src (los 8 commits) — cadenas distintivas
- instructions dedup: contiene `would double them` y `InstructionDiscovery`.
- codemode fetch 404: `FETCH_MEASUREMENT_MESSAGE = "fetch 404"` / `fetch 404 warning`.
- grep byte budget: `OPENCODE_GREP_OUTPUT_MAX_BYTES` / `boundModelContent`.
- + mensajes de error codemode, orden de deps en `packages/cli/package.json`, `.ignore`/`.slim`,
  y WIP (`packages/client/src/solid/data.ts`, `packages/tui/src/context/local.tsx`).

### Instalación ACTUAL del usuario — `C:\Users\alvar\dev\opencode-v2`
- **NO es un repo git**: es un directorio de instalación (paquete npm `@opencode/cli`).
- `node_modules\@opencode\cli` = **2.0.18**.
- `oc2.cmd`     → `opencode-v2\local-patched-202609281916\bin\opencode.exe` (version `0.0.0-local-202609281716`, built 28/09)
- `oc2-src.cmd` → `opencode-src\packages\cli\dist\cli-windows-x64\bin\opencode.exe` (el build NUEVO v2.0.20)
- `local-patched-202609281457` = version `0.0.0-local-202609281457` (solo tenía instructions-dedup).
- Ambos `local-patched-*` traen `bin\*.js.map` (source maps con el TS original).

## HALLAZGO CLAVE (ya comprobado con `Select-String -List` sobre los `.js.map`)
- `local-patched-202609281916` (el que usa `oc2.cmd`) **YA contiene los 3 parches**:
  grep-budget, codemode-404 e instructions-dedup → son los MISMOS que opencode-src, pero sobre **2.0.18**.
- `OPENCODE_DIRECT_TRACE` es upstream (existe en `opencode-src\packages\cli\src\mini-host.ts:50`), NO es parche propio.
- El binario contiene **52 tokens `OPENCODE_*`** (lista extraída, abajo). Falta cruzarlos con el repo.

### Los 52 tokens del binario (para restar los del repo)
```
OPENCODE_API_KEY, OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_CLI_CONFIG_CONTENT,
OPENCODE_CLI_NAME, OPENCODE_CLIENT, OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT,
OPENCODE_CONFIG_DIR, OPENCODE_CONFIG_PROJECT_DISABLE, OPENCODE_DB, OPENCODE_DIRECT_TRACE,
OPENCODE_DISABLE_AUTOUPDATE, OPENCODE_DISABLE_CHANNEL_DB, OPENCODE_DISABLE_FFF,
OPENCODE_DISABLE_FILEWATCHER, OPENCODE_DISABLE_MODELS_FETCH, OPENCODE_DISABLE_PROJECT_CONFIG,
OPENCODE_DRIVE, OPENCODE_DRIVE_RENDERER, OPENCODE_EDITOR_SSE_PORT, OPENCODE_FAST_BOOT,
OPENCODE_FILEWATCHER_DISABLE, OPENCODE_GIT_BASH_PATH, OPENCODE_GITLAB_AUTH_CLIENT_ID,
OPENCODE_GREP_OUTPUT_MAX_BYTES, OPENCODE_LOCAL, OPENCODE_LOG_LEVEL, OPENCODE_MODELS_PATH,
OPENCODE_MODELS_URL, OPENCODE_PASSWORD, OPENCODE_PHOTON_WASM_PATH, OPENCODE_PRINT_LOGS,
OPENCODE_PTY_BIN, OPENCODE_PTY_HANDOFF, OPENCODE_PTY_RUNTIME_DIR,
OPENCODE_REPO_CLONE_GITHUB_BASE_URL, OPENCODE_ROUTE, OPENCODE_SERVER_PASSWORD,
OPENCODE_SHOW_TTFD, OPENCODE_SIMULATE, OPENCODE_SSH_ASKPASS_PORT, OPENCODE_SSH_ASKPASS_TOKEN,
OPENCODE_STORY, OPENCODE_TERMINAL, OPENCODE_TEST_HOME, OPENCODE_TOOL_GUIDANCE,
OPENCODE_TUI_CHANNEL, OPENCODE_VERSION, OPENCODE_WORKTREE_BASE, OPENCODE_WORKTREE_PATH,
OPENCODE_ZED_DB
```

## TAREA PENDIENTE
1) Detectar si `local-patched-202609281916` tiene parches/experimentos **EXTRA** que NO estén en
   `opencode-src` (candidatos: tokens `OPENCODE_*` presentes en el binario y ausentes en el código;
   y cualquier experimento tipo **exec directo / sin shell** que aparezca en las sesiones).
2) Decidir **cuál build dejar puesto** como daily driver y **consolidar** (evitar dos binarios
   divergentes: `oc2.cmd` en 2.0.18 vs `oc2-src.cmd` en 2.0.20).

## CÓMO HACERLO RÁPIDO (la sesión anterior tardó por esto)
- **NO** uses `Get-ChildItem -Recurse` + `Get-Content -Raw` sobre `packages` ni leas `*.js.map`
  enteros: son JSON de **UNA sola línea** de hasta ~13 MB → tardísimo y agota timeout.
- Para el repo usa la **tool `grep` (ripgrep)** acotando `path` e `include`.
- Para el binario usa `Select-String -Path "...\bin\*.js.map" -SimpleMatch -Pattern X -List`
  (corta al primer match), o extrae tokens de UN solo fichero conocido.
- Comando que falta (rápido): sacar `OPENCODE_[A-Z0-9_]+` del repo con ripgrep, restarlo de la
  lista de 52 y mirar los que sobren = candidatos a parche extra.
- No repitas el update ni el fetch; no vuelvas a descargar nada.

## RESTRICCIONES
- Prohibido sin OK explícito: `git reset --hard`, `git clean`, `git push`, borrar/mover ficheros.
- No mates procesos `opencode` sin pedirlo.
- Marca lo que quede sin verificar.

## ENTREGABLE
Dime en claro: si hay o no parches extra en el binario actual; si hay **colisión real** o solo
duplicación de los mismos 3 parches en otra base; **cuál build conviene dejar** y cómo
(p. ej. reapuntar `oc2.cmd` al binario v2.0.20, o recompilar `local-patched-*` desde opencode-src).
```
