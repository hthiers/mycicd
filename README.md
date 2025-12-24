# Simple CI/CD Tool

A lightweight web-based CI/CD tool for building Docker images, pushing them to Docker Hub, and deploying them to remote servers via SSH.

## Features

- Build Docker images from your projects
  - Custom Dockerfile paths (e.g., `./web/Dockerfile.prod`)
  - Custom build context paths for subfolder builds
  - Multi-platform builds (e.g., linux/amd64)
- Push images to Docker Hub
- Deploy containers to remote servers via SSH
- Real-time job monitoring with collapsible logs
- Project configuration management with encryption
- Tag history and duplicate detection
- MySQL database for persistent storage
- Simple web interface

## Prerequisites

- Node.js (v14 or higher)
- **MySQL** (running locally on port 3306, default credentials: root/root)
- Docker installed locally (for building images)
- Docker installed on remote server (for deployment)
- Docker Hub account
- SSH access to your deployment server

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

3. Open your browser and navigate to:
```
http://localhost:3000
```

## Usage

1. **Prepare Your Project**:
   - Ensure your project has a Dockerfile (can be in root or subdirectory)
   - Note the absolute path to your project directory

2. **Fill in the Deployment Form**:

   **Build Configuration:**
   - **Project Path**: Absolute path to your project (e.g., `/Users/username/my-app`)
   - **Dockerfile Path** (optional): Relative path to Dockerfile (e.g., `./web/Dockerfile.prod`, defaults to `Dockerfile`)
   - **Context Path** (optional): Build context relative to project (e.g., `./web`, defaults to `.`)
   - **Image Name**: Name for your Docker image (e.g., `my-app`)
   - **Image Tag**: Version tag (e.g., `latest`, `v1.0.0`)
   - **Build Platform** (optional): Target platform (e.g., `linux/amd64`)
   - **Docker Hub Username**: Your Docker Hub username
   - **Docker Hub Password**: Your Docker Hub password

   **Deployment Configuration:**
   - **SSH Host**: IP or hostname of your deployment server
   - **SSH User**: SSH username (e.g., `root`, `ubuntu`)
   - **SSH Password** OR **SSH Private Key**: Authentication method
   - **SSH Passphrase** (optional): If your key is encrypted

   **Execution Configuration:**
   - **Container Name**: Name for the container on the remote server
   - **Host Port/Container Port** (optional): Port mapping
   - **Environment Variables** (optional): One per line

3. **Start Deployment**:
   - Click "Start Deployment"
   - Monitor progress in the "Recent Jobs" section (last 3 jobs shown)
   - Click "Show Logs" to view real-time logs
   - Logs update automatically every 5 seconds

## How It Works

The tool executes a 3-step deployment process:

1. **Build**: Builds a Docker image from your project directory
2. **Push**: Pushes the built image to Docker Hub
3. **Deploy**: Connects to your server via SSH and:
   - Pulls the new image from Docker Hub
   - Stops and removes the old container (if exists)
   - Starts a new container with the updated image

## API Endpoints

### POST /api/deploy
Start a new deployment job.

**Request Body**:
```json
{
  "projectPath": "/path/to/project",
  "dockerfileName": "./web/Dockerfile.prod",
  "contextPath": "./web",
  "imageName": "my-app",
  "imageTag": "latest",
  "buildPlatform": "linux/amd64",
  "dockerHubUsername": "username",
  "dockerHubPassword": "password",
  "sshHost": "192.168.1.100",
  "sshUser": "root",
  "sshPassword": "password",
  "sshPrivateKey": "-----BEGIN OPENSSH PRIVATE KEY-----...",
  "sshPassphrase": "key-passphrase",
  "containerName": "my-app-container",
  "hostPort": "80",
  "containerPort": "8080",
  "envVars": "NODE_ENV=production\nPORT=8080"
}
```

**Response**:
```json
{
  "jobId": 1,
  "message": "Deployment started"
}
```

### GET /api/jobs
Get recent jobs (last 3, merges in-memory active jobs with database).

### GET /api/jobs/:id
Get a specific job by ID (returns in-memory data for active jobs).

### GET /api/projects
Get all saved projects (encrypted).

### POST /api/projects
Create or update a project with encryption.

### POST /api/projects/:id/decrypt
Decrypt and load a project configuration.

### DELETE /api/projects/:id
Delete a project.

## Security Considerations

**Current Security Features:**
- ✅ Master password encryption for stored projects (AES-256-GCM)
- ✅ SSH key authentication support (more secure than passwords)
- ✅ MySQL database with utf8mb4 support
- ✅ Credentials encrypted at rest
- ✅ No credentials in job logs

**For production use, additionally consider:**
- Using environment variables for database credentials
- Implementing user authentication and authorization
- Adding HTTPS support (reverse proxy with nginx/caddy)
- Implementing rate limiting
- Adding input validation and sanitization
- Using a dedicated secrets management system (HashiCorp Vault, AWS Secrets Manager)
- Database backups and disaster recovery
- Monitoring and alerting

## Customization

### Dockerfile and Build Context
The tool supports custom Dockerfile paths and build contexts via the UI:

- **Dockerfile Path**: Specify path relative to project (e.g., `./docker/Dockerfile.prod`)
- **Context Path**: Specify build context relative to project (e.g., `./backend`)

**Example:** Build from `./web` folder with `Dockerfile.prod`:
```
Project Path: /Users/username/myproject
Dockerfile Path: ./web/Dockerfile.prod
Context Path: ./web
```

Equivalent to: `docker build -f ./web/Dockerfile.prod -t image ./web`

### Container Run Options
Port mapping and environment variables can be configured in the UI. For advanced options (volumes, networks, restart policies), modify the deployment command in `services/ssh.js`:

```javascript
// Example with additional options
await executeCommand(
  ssh,
  `docker run -d --name ${containerName} --restart unless-stopped -v /data:/app/data ${imageName}`,
  logCallback
);
```

## Troubleshooting

**"Connection refused" error**:
- Ensure Docker daemon is running locally
- Check if you can run `docker ps` successfully

**SSH connection fails**:
- Verify SSH credentials
- Ensure the server allows password authentication
- Check firewall rules on the remote server

**Build fails**:
- Verify the project path is correct and absolute
- Ensure Dockerfile exists in the project root
- Check Docker build logs in the job output

## License

MIT
