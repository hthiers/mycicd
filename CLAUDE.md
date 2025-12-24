# CLAUDE Context File - Custom CI/CD Tool

## Project Overview
A lightweight web-based CI/CD tool for building Docker images, pushing them to Docker Hub, and deploying containers to remote servers via SSH. Built with Node.js, Express, MySQL, and a single-page HTML frontend.

## Purpose
Simplify the Docker build-push-deploy workflow with a web interface that supports:
- Multi-platform Docker builds
- Secure credential storage with encryption
- Real-time deployment monitoring
- Project configuration management
- Tag history to prevent accidental overwrites

## Tech Stack
- **Backend**: Node.js, Express.js
- **Database**: MySQL 2 (local, default credentials: root/root)
- **Docker**: dockerode library for Docker API interaction
- **SSH**: node-ssh for remote server deployment
- **Encryption**: AES-256-GCM with PBKDF2 key derivation
- **Frontend**: Vanilla JavaScript, single HTML file with embedded CSS

## Architecture

### File Structure
```
mycicd/
├── server.js                 # Main Express server & API routes
├── services/
│   ├── docker.js            # Docker build & push operations
│   ├── ssh.js               # SSH deployment to remote servers
│   ├── crypto.js            # AES-256-GCM encryption/decryption
│   └── database.js          # MySQL database operations
├── public/
│   └── index.html           # Single-page web interface
├── package.json
└── README.md
```

### Core Components

#### 1. server.js (Main Server)
- Express server on port 3000
- API endpoints for deployments, jobs, projects, and tag history
- In-memory active job tracking (Map) + MySQL persistence
- Orchestrates the 3-step deployment process:
  1. Build Docker image
  2. Push to Docker Hub
  3. Deploy via SSH to remote server

**Key API Endpoints:**
- `POST /api/deploy` - Start new deployment job
- `GET /api/jobs` - Get recent jobs (limit 3, merges in-memory activeJobs with database)
- `GET /api/jobs/:id` - Get specific job (returns in-memory data for active jobs)
- `GET /api/projects` - Get all saved projects
- `POST /api/projects` - Create/update project with encryption
- `POST /api/projects/:id/decrypt` - Decrypt and load project
- `DELETE /api/projects/:id` - Delete project
- `GET /api/tags/:username/:imageName` - Get tag history
- `GET /api/tags/:username/:imageName/:tag/exists` - Check if tag exists

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
Uses node-ssh for remote deployment:
- `deployContainer()` - Main deployment function
- Supports both password and SSH key authentication (with passphrase)
- Deployment steps:
  1. Connect to remote server
  2. Pull new Docker image
  3. Stop and remove old container (if exists)
  4. Start new container with port mapping and environment variables
- `executeCommand()` - Executes SSH commands and captures output

#### 4. services/crypto.js
Strong encryption for sensitive project data:
- Algorithm: AES-256-GCM (authenticated encryption)
- Key derivation: PBKDF2 with 100,000 iterations using SHA-512
- Random salt (64 bytes) and IV (16 bytes) for each encryption
- Format: `salt:iv:tag:encrypted` (hex-encoded)
- Used to encrypt: Docker Hub password, SSH password, SSH private key, SSH passphrase

#### 5. services/database.js
MySQL database with three tables (all using utf8mb4 charset for full Unicode support):

**projects table:**
- Stores deployment configurations with encrypted credentials
- Fields: id, name, config (JSON as TEXT utf8mb4), created_at, updated_at
- Config includes all deployment parameters including dockerfileName and contextPath

**jobs table:**
- Stores deployment job history and logs
- Fields: id, status, logs (plain string as MEDIUMTEXT utf8mb4), config (JSON as MEDIUMTEXT utf8mb4), created_at
- Status values: pending, running, completed, failed
- **Logs storage**: Plain newline-separated string (not JSON array) for 60-70% space savings
- **Log format**: No timestamps on individual lines (job has created_at for start time)
- MEDIUMTEXT supports up to 16MB of logs per job

**image_tags table:**
- Tracks Docker image tag history
- Fields: id, image_key (username/imagename), tag, job_id, created_at
- Unique constraint on (image_key, tag, created_at)
- Used to warn users about tag overwrites

#### 6. public/index.html
Single-page web application with:
- Project management UI:
  - Load Project (decrypt and populate form)
  - **Save Changes** (update current project without re-entering name)
  - Save as Project (create new or save with new name)
  - Delete Project
  - All with master password encryption
- Collapsible deployment form sections:
  - Build Configuration (project path, **dockerfile path**, **context path**, image name/tag, platform, Docker Hub credentials)
  - Deployment Configuration (SSH host/user/password/key/passphrase)
  - Execution Configuration (container name, port mapping, environment variables)
- Real-time job monitoring:
  - Shows last **3 jobs only** (optimized for performance)
  - Auto-refresh every 5 seconds
  - **Collapsible logs** (hidden by default with Show/Hide toggle)
  - Log visibility state preserved across refreshes
  - Merges in-memory activeJobs data with database for real-time updates
- Tag history display and duplicate warning
- Dark-themed log console with auto-scroll

## Data Flow

### Deployment Process
1. User fills form and clicks "Start Deployment"
2. Frontend validates SSH auth (password OR private key required)
3. POST request to `/api/deploy` with all configuration
4. Server creates job in database and returns jobId
5. Server stores job in activeJobs Map for real-time updates
6. Async `runDeployment()` function executes:
   - Step 1: Build Docker image (dockerode)
   - Step 2: Push to Docker Hub (dockerode with auth)
   - Step 3: Deploy via SSH (node-ssh)
7. Each step logs progress to job.logs array
8. On completion/failure, update job status in database
9. Record successful tag in image_tags table
10. Remove job from activeJobs Map
11. Frontend auto-refreshes and displays updated status/logs

### Project Save/Load Flow
1. **Save**: User enters project name + master password → Frontend sends config → Server encrypts sensitive fields using crypto.js → Store in projects table
2. **Load**: User selects project + enters master password → Server retrieves encrypted config → Decrypts with crypto.js → Frontend populates form fields

## Key Features

### Security
- Master password-based encryption for stored projects (never stored, only used for encryption/decryption)
- AES-256-GCM authenticated encryption
- PBKDF2 key derivation with 100K iterations
- Credentials never logged or exposed in job history
- Support for SSH key authentication (more secure than passwords)

### User Experience
- Collapsible form sections to reduce UI clutter
- Real-time log streaming during deployment (merges in-memory with database)
- **Collapsible logs** - hidden by default, click to show/hide
- Log visibility preserved during auto-refresh
- **Limited to 3 recent jobs** for clean UI and better performance
- Tag history shows last 5 tags for selected image
- Duplicate tag warning to prevent accidental overwrites
- Auto-refresh jobs every 5 seconds
- Color-coded job status badges (pending/running/completed/failed)
- Dark-themed log console with auto-scroll
- **Save Changes button** - quick updates to loaded projects

### Flexibility
- **Custom Dockerfile paths** (e.g., `./web/Dockerfile.prod`)
- **Custom build context paths** (e.g., `./web` for subfolder builds)
- Both paths relative to Project Path (works like `docker build -f ... context`)
- Optional platform-specific builds (e.g., build on macOS for linux/amd64)
- Optional port mapping (hostPort:containerPort)
- Optional environment variables (newline-separated)
- SSH authentication via password OR private key (with optional passphrase)
- Support for custom container run options

## Database Configuration
- **Host**: localhost
- **Port**: 3306
- **User**: root
- **Password**: root (hardcoded in services/database.js:7)
- **Database**: cicd_tool (auto-created on startup with utf8mb4 charset)
- **Charset**: utf8mb4 with utf8mb4_unicode_ci collation (full Unicode support)
- **Auto-migrations**: Automatically converts existing tables to utf8mb4 and MEDIUMTEXT on startup

## Common Operations

### Starting the Server
```bash
npm start          # Production mode
npm run dev        # Development mode with nodemon
```

### Making Changes

**Adding a new deployment step:**
- Modify `runDeployment()` function in server.js (lines 213-255)
- Add new service function if needed
- Update logs with `addLog(jobId, message)`

**Changing Docker Hub registry:**
- Modify `fullImageName` construction in server.js:215
- Update dockerService.pushImage() auth in services/docker.js

**Customizing container run command:**
- Modify docker run command construction in services/ssh.js:44-63
- Add additional flags like --restart, --network, -v for volumes

**Adding new encrypted fields:**
- Update encryption/decryption in server.js:92-108 (save) and 144-160 (load)
- Update frontend getFormData() and setFormData() in index.html

**Changing database connection:**
- Update DB_CONFIG in services/database.js:3-8
- Consider using environment variables for production

### Troubleshooting

**"Connection refused" error:**
- Check if Docker daemon is running: `docker ps`
- Verify project path is absolute and contains Dockerfile

**SSH connection fails:**
- Verify SSH credentials
- Check if server allows password authentication (if not using key)
- Ensure firewall allows SSH connections
- Test SSH manually: `ssh user@host`

**Database connection fails:**
- Check if MySQL is running: `mysql -u root -p`
- Verify credentials in services/database.js
- Ensure MySQL is accessible on localhost:3306

**Build fails:**
- Verify Dockerfile exists in project path
- Check Docker build logs in job output
- Ensure no syntax errors in Dockerfile

**Decryption fails:**
- Wrong master password
- Corrupted encrypted data
- Encryption/decryption version mismatch

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

### Why master password encryption?
- Secure credential storage without external key management
- User controls their own encryption key
- No plaintext passwords in database
- Balance between security and usability

## Future Improvement Ideas
(Not implemented, but could be useful)

- WebSocket for real-time log streaming (replace polling)
- User authentication and multi-tenancy
- GitHub/GitLab webhook integration
- Build caching and incremental builds
- Docker Compose support
- Kubernetes deployment option
- Slack/Discord notifications
- Deployment rollback feature
- Environment-specific configurations (dev/staging/prod)
- Build artifacts and image scanning
- Rate limiting and queue management
- Support for multiple Docker registries (GCR, ECR, etc.)
- Automated testing before deployment
- Deployment approval workflow

## Dependencies
Key npm packages (see package.json):
- express: Web server framework
- dockerode: Docker API client
- node-ssh: SSH client
- body-parser: Request body parsing middleware
- tar-fs: Create tar streams for Docker build context
- mysql2: MySQL client with promise support
- nodemon: Development auto-reload (devDependency)

## Git Information
- Current branch: main
- Main branch for PRs: main
- Recent commits focus on: workflow UI improvements, pipeline organization

## Notes for Claude
- When asked to modify deployment logic, focus on server.js:213-255 (runDeployment function)
- When asked about encryption, refer to services/crypto.js
- When debugging, check both activeJobs Map (in-memory) and database state
- Form field IDs in index.html match config property names in server.js
- Database migrations are handled in createTables() function with ALTER TABLE statements
- No environment variables used - all config is hardcoded (consider this for production improvements)
- The tool assumes Docker is installed both locally (for build) and remotely (for deployment)
