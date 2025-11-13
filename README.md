# Simple CI/CD Tool

A lightweight web-based CI/CD tool for building Docker images, pushing them to Docker Hub, and deploying them to remote servers via SSH.

## Features

- Build Docker images from your projects
- Push images to Docker Hub
- Deploy containers to remote servers via SSH
- Real-time job monitoring and logs
- Simple web interface
- In-memory job history

## Prerequisites

- Node.js (v14 or higher)
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
   - Ensure your project has a `Dockerfile` in its root directory
   - Note the absolute path to your project directory

2. **Fill in the Deployment Form**:
   - **Project Path**: Absolute path to your project (e.g., `/Users/username/my-app`)
   - **Image Name**: Name for your Docker image (e.g., `my-app`)
   - **Image Tag**: Version tag (e.g., `latest`, `v1.0.0`)
   - **Docker Hub Username**: Your Docker Hub username
   - **Docker Hub Password**: Your Docker Hub password
   - **SSH Host**: IP or hostname of your deployment server
   - **SSH User**: SSH username (e.g., `root`, `ubuntu`)
   - **SSH Password**: SSH password
   - **Container Name**: Name for the container on the remote server

3. **Start Deployment**:
   - Click "Start Deployment"
   - Monitor progress in the "Recent Jobs" section
   - Logs will update in real-time

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
  "imageName": "my-app",
  "imageTag": "latest",
  "dockerHubUsername": "username",
  "dockerHubPassword": "password",
  "sshHost": "192.168.1.100",
  "sshUser": "root",
  "sshPassword": "password",
  "containerName": "my-app-container"
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
Get all jobs.

### GET /api/jobs/:id
Get a specific job by ID.

## Security Considerations

This is a basic implementation intended for personal use or development environments. For production use, consider:

- Using environment variables or a secure vault for credentials
- Implementing user authentication
- Using SSH keys instead of passwords
- Adding HTTPS support
- Implementing rate limiting
- Adding input validation and sanitization
- Storing credentials encrypted
- Using a proper database instead of in-memory storage

## Customization

### Container Run Options
Currently, containers are started with basic `docker run -d` command. To add custom options (ports, volumes, environment variables), modify the deployment command in `services/ssh.js`:

```javascript
// Example with port mapping and environment variables
await executeCommand(
  ssh,
  `docker run -d --name ${containerName} -p 80:8080 -e NODE_ENV=production ${imageName}`,
  logCallback
);
```

### Build Context
The tool builds images from the entire project directory. To customize build context or use a different Dockerfile, modify `services/docker.js`.

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
