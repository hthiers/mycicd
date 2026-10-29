# CLAUDE Context File - Custom CI/CD Tool

## Project Overview
A lightweight web-based CI/CD tool with two deployment pipelines:
1. **Docker**: build an image, push it to Docker Hub, and run it as a container on a remote server via SSH.
2. **PHP / Nginx (VPS)**: sync only new/modified project files to a remote directory via SFTP checksum diffing (no containers), then optionally run post-deploy commands (composer, artisan, etc.) — for apps that run directly on a VPS (e.g. Laravel behind Nginx).

Single-admin login gates the whole app; per-account encryption protects stored credentials. Built with Node.js, Express, MySQL, and a single-page HTML frontend.

## Tech Stack
- **Backend**: Node.js, Express.js
- **Database**: MySQL 2, configured via `.env` (see Database Configuration below)
- **Docker**: dockerode library for Docker API interaction
- **SSH/SFTP**: node-ssh for remote server deployment and file transfer (both pipelines)
- **Auth**: express-session (server-side session) + bcrypt password hashing
- **Encryption**: AES-256-GCM with PBKDF2 key derivation, envelope-encrypted per-account DEK (see Security below)
- **Frontend**: Vanilla JavaScript, single HTML file with embedded CSS

## Architecture

### File Structure
```
mycicd/
├── server.js                 # Main Express server & API routes
├── services/
│   ├── docker.js            # Docker build & push operations
│   ├── ssh.js               # SSH connection + Docker container deployment
│   ├── phpDeploy.js         # PHP/Nginx file-sync deployment (checksum diff over SFTP)
│   ├── crypto.js            # AES-256-GCM encryption/decryption
│   ├── auth.js              # Password hashing + DEK wrap/unwrap
│   └── database.js          # MySQL database operations
├── public/
│   └── index.html           # Single-page web interface
├── .env                      # PORT, SESSION_SECRET, DB_* (gitignored)
├── .env.example               # Template for .env
├── package.json
└── README.md
```

### Core Components

#### 1. server.js (Main Server)
- Express server, port from `.env` (`PORT`, defaults to 3001)
- Refuses to start if `SESSION_SECRET` is missing from `.env`
- Session-based auth gates every `/api/*` route except `/api/auth/*` (see Security)
- In-memory active job tracking (Map) + MySQL persistence
- Routes deployments by `config.deployType` (`'docker'` default, or `'php'`):
  - `runDockerDeployment()`: build → push → SSH container deploy
  - `runPhpDeployment()`: delegates to `services/phpDeploy.js`

**Key API Endpoints:**
- `POST /api/auth/setup` - Create the (single) admin account, first run only
- `POST /api/auth/login` / `POST /api/auth/logout`
- `GET /api/auth/status` - `{ setupNeeded, authenticated }`
- `POST /api/deploy` - Start new deployment job (`deployType: 'docker' | 'php'`)
- `GET /api/jobs` - Get recent jobs (limit 3, merges in-memory activeJobs with database)
- `GET /api/jobs/:id` - Get specific job (returns in-memory data for active jobs)
- `GET /api/projects` - Get all saved projects
- `POST /api/projects` - Create/update project with encryption
- `POST /api/projects/:id/decrypt` - Decrypt and load project (handles legacy master-password migration)
- `DELETE /api/projects/:id` - Delete project
- `GET /api/tags/:username/:imageName` - Get tag history (Docker only)
- `GET /api/tags/:username/:imageName/:tag/exists` - Check if tag exists (Docker only)

#### 2. services/docker.js
Uses dockerode library to interact with Docker daemon:
- `buildImage()` - Builds Docker image from tar stream of project directory
  - Supports custom Dockerfile paths (relative to project path)
  - Supports custom build context paths (relative to project path)
  - Automatically resolves Dockerfile path relative to build context for Docker API
- `pushImage()` - Pushes image to Docker Hub with authentication
- Streams build/push progress to log callbacks
- Supports platform-specific builds (e.g., linux/amd64)

#### 3. services/ssh.js
Uses node-ssh for remote connections, shared by both pipelines:
- `connect(host, username, password, sshPrivateKey, sshPassphrase, logCallback)` - opens and returns a connected `NodeSSH` instance; handles password vs. key (+ optional passphrase) auth. Used by both `deployContainer()` and `phpDeploy.js`.
- `deployContainer()` - Docker pipeline's remote deploy step:
  1. `connect()`
  2. Pull new Docker image
  3. Stop and remove old container (if exists)
  4. Start new container with port mapping and environment variables
- `executeCommand()` - Executes SSH commands, captures stdout/stderr, throws on non-zero exit. Exported for reuse by `phpDeploy.js`.

#### 4. services/phpDeploy.js
File-sync deployment for non-Docker (PHP/Nginx) targets. No new dependencies — pure `node-ssh` SFTP + Node's built-in `crypto`/`fs`.
- `deployPhp(config, logCallback)` - orchestrates the whole flow:
  1. `sshService.connect()`
  2. `buildLocalManifest()` - walks `projectPath` locally, SHA-256-hashes every non-ignored file
  3. `getRemoteManifest()` - runs one `find <remotePath> -type f -exec sha256sum {} \;` over SSH, parses into a map
  4. `diffManifests()` - files that are new or have a different hash get queued for upload; **never deletes** files that exist remotely but not locally (intentional — safe by default for `storage/`, `.env`, user uploads, etc.)
  5. `syncFiles()` - uploads only the diffed files via `ssh.putFile()` (node-ssh auto-creates missing parent directories on upload)
  6. `writeEnvFile()` - if `envFileContent` is set, writes it as `remotePath/.env` (base64 pipe over SSH, same pattern as the Docker env-file mode)
  7. `runPostDeployCommands()` - runs each non-empty line as `cd <remotePath> && <command>`, in order
- **Ignore patterns** (`shouldIgnore()` / `compilePattern()`): newline-separated glob patterns (`*` = any chars within one path segment, `?` = one char). A pattern with no `/` matches that file/folder name at any depth; a pattern with `/` matches that exact relative path (and anything nested under it if it's a directory). Patterns are normalized (strips leading `./`, leading/trailing `/`) so `vendor/`, `/vendor`, and `vendor` are equivalent. `.git` is always ignored regardless of user config.
- **Does not create `remotePath` itself** - by design, the destination directory must already exist and be owned/writable by the SSH user (e.g. the site directory aaPanel creates). `find` will fail with "No such file or directory" if it doesn't exist yet.
- **Does not create empty directories that are fully ignored** - e.g. if `storage/framework/views/` is in the ignore list and never existed on the server, the sync will never create it (it only creates dirs as a side effect of uploading a file into them). Laravel needs these directories to exist even though their contents shouldn't be synced — handle via a `mkdir -p ...` step in Post-Deploy Commands if the target is a fresh server.

#### 5. services/crypto.js
Strong encryption, used both for the per-account DEK envelope and for legacy per-project fields:
- Algorithm: AES-256-GCM (authenticated encryption)
- Key derivation: PBKDF2 with 100,000 iterations using SHA-512
- Random salt (64 bytes) and IV (16 bytes) for each encryption
- `encrypt`/`decrypt` (legacy, password-derived key, format `salt:iv:tag:encrypted`) vs. `encryptWithKey`/`decryptWithKey` (raw key, format `iv:tag:encrypted`, used with the account DEK)

#### 6. services/auth.js
Login + envelope encryption for the single admin account:
- `hashPassword()`/`verifyPassword()` - bcrypt (12 rounds)
- `generateDEK()` - random 32-byte data encryption key, created once at account setup
- `wrapDEK()`/`unwrapDEK()` - wraps the DEK with a key derived (PBKDF2) from the login password, so the DEK itself never touches disk unencrypted
- The unwrapped DEK lives only in an in-memory `dekMap` in `server.js`, keyed by session ID — never persisted, never in the cookie, lost on logout or server restart (any project loaded mid-session will need the user to log in again after a restart)

#### 7. services/database.js
MySQL database with four tables (all utf8mb4). Connection config comes from `.env` (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`), falling back to `localhost:3306 root/root cicd_tool_v2` if unset.

**users table:** single admin account — `username`, `password_hash` (bcrypt), `dek_salt`/`dek_iv`/`dek_tag`/`dek_encrypted` (wrapped DEK).

**projects table:**
- Stores deployment configurations with encrypted credentials
- Fields: id, name, config (JSON as TEXT utf8mb4), created_at, updated_at
- `config` holds `deployType` plus every field relevant to that type (Docker fields are `null`/absent for `php` projects and vice versa). Secret fields (`dockerHubPassword`, `sshPassword`, `sshPrivateKey`, `sshPassphrase`) are encrypted with the account DEK; everything else (including `envFileContent`, which may contain app secrets like `APP_KEY`/DB creds) is stored as plain JSON, consistent with how `envVars` was already handled for Docker.

**jobs table:**
- Stores deployment job history and logs
- Fields: id, status, logs (plain string as MEDIUMTEXT utf8mb4), config (JSON as MEDIUMTEXT utf8mb4), created_at
- Status values: pending, running, completed, failed
- **Logs storage**: Plain newline-separated string (not JSON array) for 60-70% space savings
- MEDIUMTEXT supports up to 16MB of logs per job

**image_tags table:**
- Tracks Docker image tag history (Docker deploys only; `php` deploys never write here)
- Fields: id, image_key (username/imagename), tag, job_id, created_at
- Unique constraint on (image_key, tag, created_at)

#### 8. public/index.html
Single-page web application:
- Login/setup overlay (first run creates the admin account; a 401 on any `/api/*` call drops back to it)
- **Deployment Type selector**: two icon buttons (Docker whale / file icon) driving a hidden `#deployType` input; `applyDeployTypeVisibility()` toggles which form sections are visible and which fields are `required`
- Project management UI: Load Project, Save Changes, Save as Project, Delete Project
- Collapsible deployment form sections:
  - Shared: Deployment Type, Project Path, **Deployment Configuration** (SSH host/user/password/key/passphrase)
  - Docker-only (`.docker-only-section`): Build Configuration (dockerfile/context path, image name/tag, platform, Docker Hub credentials, tag history), Execution Configuration (container name, ports, env vars, volumes)
  - PHP-only (`.php-only-section`): PHP Deployment Configuration (Remote Path, Ignore Patterns, `.env` File Content, Post-Deploy Commands)
- `getFormData()`/`setFormData()` cover both pipelines' fields; project save/load restores the correct deploy type and section visibility
- Real-time job monitoring: last 3 jobs, auto-refresh every 5s, collapsible logs, color-coded status badges

## Data Flow

### Docker Deployment Process
1. User fills form (Deployment Type = Docker) and clicks "Start Deployment"
2. Frontend validates SSH auth (password OR private key required)
3. POST `/api/deploy` with `deployType: 'docker'` + config
4. Server creates job in DB, tracks it in `activeJobs`, returns `jobId`
5. `runDockerDeployment()`: build image (dockerode) → push to Docker Hub → `sshService.deployContainer()` → record tag in `image_tags`
6. Logs stream into `job.logs`; status persisted to DB on each transition; job removed from `activeJobs` on completion/failure

### PHP Deployment Process
1. User fills form (Deployment Type = PHP), sets Project Path + Remote Path (+ optional ignore patterns / `.env` content / post-deploy commands) and SSH creds
2. POST `/api/deploy` with `deployType: 'php'` + config (no Docker Hub/image/container fields required)
3. `runPhpDeployment()` → `phpDeployService.deployPhp()`: connect → diff local vs. remote checksums → upload changed files only → optionally write `.env` → run post-deploy commands in order
4. Same job/log/status machinery as Docker deploys; no `image_tags` entry

### Project Save/Load Flow
1. **Save**: user is logged in (DEK already unwrapped in `dekMap`) → frontend sends config → server encrypts secret fields with the account DEK → stored in `projects` table
2. **Load**: server decrypts secret fields with the account DEK (or migrates a legacy master-password-encrypted project, prompting once for the old password) → frontend `setFormData()` populates the form, including deploy type

## Key Features

### Security
- Single-admin login (bcrypt password hash), server-side session, `SESSION_SECRET` required in `.env`
- Envelope encryption: per-account DEK (random, generated at setup) wraps/encrypts project secrets; the DEK itself is wrapped with a key derived from the login password and only decrypted in-memory per session
- AES-256-GCM authenticated encryption, PBKDF2 (100K iterations, SHA-512)
- Credentials never logged or exposed in job history
- Support for SSH key authentication (more secure than passwords)
- PHP pipeline never deletes files on the remote server automatically (no destructive sync)

### User Experience
- Deployment Type toggle (icon buttons) switches the whole form between Docker and PHP modes
- Collapsible form sections to reduce UI clutter
- Real-time log streaming during deployment (merges in-memory with database)
- Collapsible logs, hidden by default
- Limited to 3 recent jobs for clean UI and better performance
- Tag history + duplicate-tag warning (Docker only)
- Auto-refresh jobs every 5 seconds
- Color-coded job status badges (pending/running/completed/failed)

### Flexibility
- Docker: custom Dockerfile/context paths, optional platform builds, optional port mapping, env vars, volumes, SSH password or key auth
- PHP: custom ignore patterns (with glob support), optional `.env` file write, arbitrary ordered post-deploy shell commands, checksum-based partial sync (no full-tree re-upload on every deploy)

## Database Configuration
Read from `.env` (see `.env.example`), with hardcoded fallbacks in `services/database.js` if unset:
- **DB_HOST**: localhost
- **DB_PORT**: 3306
- **DB_USER**: root
- **DB_PASSWORD**: root
- **DB_NAME**: cicd_tool_v2
- **Charset**: utf8mb4 with utf8mb4_unicode_ci collation
- **Auto-migrations**: Automatically converts existing tables to utf8mb4/MEDIUMTEXT on startup

`.env` is gitignored; `.env.example` documents the expected keys (`PORT`, `SESSION_SECRET`, `DB_*`) without real secrets.

## Common Operations

### Starting the Server
```bash
npm start          # Production mode
npm run dev        # Development mode with nodemon
```

### Making Changes

**Adding a new deployment step (Docker):**
- Modify `runDockerDeployment()` in server.js
- Add new service function if needed
- Update logs with `addLog(jobId, message)`

**Adding a new deployment step (PHP):**
- Modify `deployPhp()` in services/phpDeploy.js, or add a new post-sync step called from it
- Reuse `sshService.executeCommand()` for anything that just needs to run a remote shell command

**Changing Docker Hub registry:**
- Modify `fullImageName` construction in `runDockerDeployment()` (server.js)
- Update `dockerService.pushImage()` auth in services/docker.js

**Customizing container run command:**
- Modify docker run command construction in `services/ssh.js` (`deployContainer`)
- Add additional flags like --restart, --network, -v for volumes

**Changing PHP ignore-pattern matching:**
- `compilePattern()`/`shouldIgnore()` in services/phpDeploy.js — patterns compile to per-segment or per-path regexes; `*`/`?` are scoped to a single path segment (no cross-directory `**` support currently)

**Adding new encrypted fields:**
- Update `encryptedConfig`/`decryptedConfig` construction in server.js (`POST /api/projects` and `POST /api/projects/:id/decrypt`)
- Update frontend `getFormData()`/`setFormData()` in index.html
- Only encrypt fields that are genuinely secret — most PHP/Docker config fields (paths, commands, ports) are stored as plain JSON, matching existing fields like `containerName`/`envVars`

**Changing database connection:**
- Update `.env` (`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`); fallbacks live in `services/database.js`

### Troubleshooting

**"Connection refused" error (Docker):**
- Check if Docker daemon is running: `docker ps`
- Verify project path is absolute and contains Dockerfile

**SSH connection fails:**
- Verify SSH credentials
- Check if server allows password authentication (if not using key)
- Ensure firewall allows SSH connections
- Test SSH manually: `ssh user@host`

**PHP deploy: `find: '<remotePath>': No such file or directory`:**
- The remote directory doesn't exist yet. The tool intentionally does not create it — create it manually first (e.g. via aaPanel's site creation, which provisions the directory) and make sure the SSH user can write to it.

**PHP deploy: `Permission denied` uploading files:**
- The SSH user needs write access to `remotePath`. Typical aaPanel fix: add the deploy user to the site's group (commonly `www`), then `chmod g+w` (and `g+s`/setgid on the top-level directory so new subdirectories keep inheriting the right group as the sync creates them).
- Files uploaded via SFTP get the default umask (commonly `644`, no group-write) even inside a `775`+setgid directory — existing files may need an explicit `chmod -R g+w` the first time.

**PHP deploy: ignored folder/file still gets uploaded:**
- Check the exact pattern in Ignore Patterns — trailing/leading slashes are normalized, but glob wildcards (`*`, `?`) only match within a single path segment (e.g. `storage/*.key` matches files, not `storage/**/*.key` across subdirectories).

**PHP deploy: `php artisan view:cache` (or similar) fails with "path not found":**
- Happens when a directory used only at runtime (e.g. `storage/framework/views`) is in Ignore Patterns and never existed on a fresh target — the sync never creates empty/fully-ignored directories. Add a `mkdir -p storage/framework/{cache,sessions,testing,views} storage/logs bootstrap/cache` step in Post-Deploy Commands (before any `artisan` cache commands) for first-time deploys to a fresh server.

**Post-deploy npm/composer commands fail with `EACCES` on a shared cache dir:**
- Seen with aaPanel's shared Node.js cache (`/www/server/nodejs/cache`) when it has root-owned files from a previous root-run npm. Either `chown -R <uid>:<gid>` the shared cache once, or point the deploy command at a project-local cache (`npm ci --cache <remotePath>/.npm-cache`) so it doesn't depend on shared server state.

**Database connection fails:**
- Check if MySQL is running: `mysql -u root -p`
- Verify `.env` DB_* values
- Ensure MySQL is accessible on the configured host/port

**Decryption fails:**
- Wrong master password (legacy per-project encryption) or wrong login password (current DEK-based encryption)
- Corrupted encrypted data

## Design Decisions

### Why MySQL instead of in-memory?
- Persistent job history across server restarts
- Ability to query historical deployments
- Tag history for duplicate detection
- Project configurations with encryption

### Why in-memory activeJobs Map?
- Fast real-time log updates during deployment
- Reduced database writes during active jobs
- Only persisted on status changes and completion

### Why single HTML file?
- Simplicity - no build process required
- Fast development iteration
- No bundler/transpiler needed
- Easy deployment (just serve static file)

### Why per-account DEK instead of per-project master password?
- One login password unlocks everything instead of a password per saved project
- The DEK never leaves memory unencrypted and is never stored on disk
- Legacy per-project master-password-encrypted projects still load via a one-time migration path in `POST /api/projects/:id/decrypt`

### Why SFTP checksum diff instead of rsync for the PHP pipeline?
- No new external dependencies (no `rsync`/`sshpass` binary requirement on either side) — reuses `node-ssh`, already a dependency for the Docker pipeline
- Works identically with password or key-based SSH auth
- Trade-off: hashes every local file on every deploy (SHA-256 over the whole tree), which is fine for typical project sizes but is not as bandwidth/CPU-efficient as rsync's binary diffing for very large trees

### Why does the PHP pipeline never delete remote files?
- Safety: avoids destroying `storage/`, `.env`, user uploads, or anything else that only exists on the server, with no confirmation step. Orphaned files must be cleaned up manually.

## Future Improvement Ideas
(Not implemented, but could be useful)

- WebSocket for real-time log streaming (replace polling)
- Cancel/stop a running job (currently the only way to stop one is restarting the server process)
- GitHub/GitLab webhook integration
- Build caching and incremental builds
- Docker Compose support
- Kubernetes deployment option
- Slack/Discord notifications
- Deployment rollback feature (both pipelines)
- Environment-specific configurations (dev/staging/prod)
- Optional "delete orphaned remote files" mode for the PHP pipeline (explicitly opted out of for now — safety default)
- `**` (cross-directory) glob support in PHP ignore patterns
- Rate limiting and queue management
- Support for multiple Docker registries (GCR, ECR, etc.)
- Automated testing before deployment
- Deployment approval workflow

## Dependencies
Key npm packages (see package.json):
- express: Web server framework
- express-session: Server-side session management
- bcrypt: Password hashing for the admin account
- dotenv: Loads `.env` config
- dockerode: Docker API client
- node-ssh: SSH client + SFTP (used by both the Docker and PHP pipelines)
- body-parser: Request body parsing middleware
- tar-fs: Create tar streams for Docker build context
- mysql2: MySQL client with promise support
- nodemon: Development auto-reload (devDependency)

## Git Information
- Current branch: main
- Main branch for PRs: main
- Recent commits focus on: adding the PHP/Nginx (non-Docker) deployment pipeline alongside the existing Docker pipeline, plus login/DEK-based encryption

## Notes for Claude
- When asked to modify Docker deployment logic, focus on `runDockerDeployment()` in server.js and `services/ssh.js`/`services/docker.js`
- When asked to modify PHP deployment logic, focus on `runPhpDeployment()` in server.js and `services/phpDeploy.js`
- When asked about encryption, refer to `services/crypto.js` (primitives) and `services/auth.js` (DEK wrap/unwrap)
- When debugging, check both `activeJobs` Map (in-memory) and database state
- Form field IDs in index.html match config property names in server.js
- Database migrations are handled in `createTables()` in services/database.js via ALTER TABLE statements
- DB connection, port, and session secret come from `.env` (not hardcoded) — see `.env.example`
- The Docker pipeline assumes Docker is installed both locally (for build) and remotely (for deployment)
- The PHP pipeline assumes the remote target directory already exists and is writable by the configured SSH user — it will not create it
