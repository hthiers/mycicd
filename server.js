const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const dockerService = require('./services/docker');
const sshService = require('./services/ssh');
const cryptoService = require('./services/crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory job storage
const jobs = [];
let jobIdCounter = 1;

// In-memory project storage
const projects = [];
let projectIdCounter = 1;

// API Routes
app.post('/api/deploy', async (req, res) => {
  const { projectPath, imageName, imageTag, dockerHubUsername, dockerHubPassword, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, containerName, hostPort, containerPort, buildPlatform, envVars } = req.body;

  // Validate required fields
  if (!projectPath || !imageName || !imageTag || !dockerHubUsername || !dockerHubPassword || !sshHost || !sshUser || !containerName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate SSH authentication - must have either password or private key
  if (!sshPassword && !sshPrivateKey) {
    return res.status(400).json({ error: 'Either SSH password or SSH private key must be provided' });
  }

  const jobId = jobIdCounter++;
  const job = {
    id: jobId,
    status: 'pending',
    logs: [],
    createdAt: new Date().toISOString(),
    config: { projectPath, imageName, imageTag, sshHost, containerName, hostPort, containerPort, buildPlatform }
  };

  jobs.push(job);
  res.json({ jobId, message: 'Deployment started' });

  // Run deployment asynchronously
  runDeployment(job, { projectPath, imageName, imageTag, dockerHubUsername, dockerHubPassword, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, containerName, hostPort, containerPort, buildPlatform, envVars });
});

app.get('/api/jobs', (req, res) => {
  // Return jobs without sensitive info
  const safeJobs = jobs.map(job => ({
    id: job.id,
    status: job.status,
    logs: job.logs,
    createdAt: job.createdAt,
    config: job.config
  }));
  res.json(safeJobs);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.find(j => j.id === parseInt(req.params.id));
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({
    id: job.id,
    status: job.status,
    logs: job.logs,
    createdAt: job.createdAt,
    config: job.config
  });
});

// Project Management API Routes

// Get all projects (without decrypted sensitive data)
app.get('/api/projects', (req, res) => {
  const safeProjects = projects.map(project => ({
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  }));
  res.json(safeProjects);
});

// Create or update project
app.post('/api/projects', (req, res) => {
  const { id, name, masterPassword, config } = req.body;

  if (!name || !masterPassword || !config) {
    return res.status(400).json({ error: 'Missing required fields: name, masterPassword, config' });
  }

  try {
    // Encrypt sensitive fields
    const encryptedConfig = {
      projectPath: config.projectPath,
      imageName: config.imageName,
      imageTag: config.imageTag,
      buildPlatform: config.buildPlatform,
      dockerHubUsername: config.dockerHubUsername,
      dockerHubPassword: cryptoService.encrypt(config.dockerHubPassword, masterPassword),
      sshHost: config.sshHost,
      sshUser: config.sshUser,
      sshPassword: config.sshPassword ? cryptoService.encrypt(config.sshPassword, masterPassword) : null,
      sshPrivateKey: config.sshPrivateKey ? cryptoService.encrypt(config.sshPrivateKey, masterPassword) : null,
      sshPassphrase: config.sshPassphrase ? cryptoService.encrypt(config.sshPassphrase, masterPassword) : null,
      containerName: config.containerName,
      hostPort: config.hostPort,
      containerPort: config.containerPort,
      envVars: config.envVars
    };

    if (id) {
      // Update existing project
      const projectIndex = projects.findIndex(p => p.id === parseInt(id));
      if (projectIndex === -1) {
        return res.status(404).json({ error: 'Project not found' });
      }
      projects[projectIndex] = {
        id: parseInt(id),
        name,
        config: encryptedConfig,
        createdAt: projects[projectIndex].createdAt,
        updatedAt: new Date().toISOString()
      };
      res.json({ id: parseInt(id), message: 'Project updated successfully' });
    } else {
      // Create new project
      const newProject = {
        id: projectIdCounter++,
        name,
        config: encryptedConfig,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      projects.push(newProject);
      res.json({ id: newProject.id, message: 'Project created successfully' });
    }
  } catch (error) {
    res.status(500).json({ error: `Encryption failed: ${error.message}` });
  }
});

// Get project by ID and decrypt
app.post('/api/projects/:id/decrypt', (req, res) => {
  const { masterPassword } = req.body;
  const project = projects.find(p => p.id === parseInt(req.params.id));

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  if (!masterPassword) {
    return res.status(400).json({ error: 'Master password required' });
  }

  try {
    // Decrypt sensitive fields
    const decryptedConfig = {
      projectPath: project.config.projectPath,
      imageName: project.config.imageName,
      imageTag: project.config.imageTag,
      buildPlatform: project.config.buildPlatform,
      dockerHubUsername: project.config.dockerHubUsername,
      dockerHubPassword: cryptoService.decrypt(project.config.dockerHubPassword, masterPassword),
      sshHost: project.config.sshHost,
      sshUser: project.config.sshUser,
      sshPassword: project.config.sshPassword ? cryptoService.decrypt(project.config.sshPassword, masterPassword) : '',
      sshPrivateKey: project.config.sshPrivateKey ? cryptoService.decrypt(project.config.sshPrivateKey, masterPassword) : '',
      sshPassphrase: project.config.sshPassphrase ? cryptoService.decrypt(project.config.sshPassphrase, masterPassword) : '',
      containerName: project.config.containerName,
      hostPort: project.config.hostPort,
      containerPort: project.config.containerPort,
      envVars: project.config.envVars
    };

    res.json({
      id: project.id,
      name: project.name,
      config: decryptedConfig
    });
  } catch (error) {
    res.status(400).json({ error: 'Decryption failed. Invalid master password or corrupted data.' });
  }
});

// Delete project
app.delete('/api/projects/:id', (req, res) => {
  const projectIndex = projects.findIndex(p => p.id === parseInt(req.params.id));

  if (projectIndex === -1) {
    return res.status(404).json({ error: 'Project not found' });
  }

  projects.splice(projectIndex, 1);
  res.json({ message: 'Project deleted successfully' });
});

// Deployment function
async function runDeployment(job, config) {
  const { projectPath, imageName, imageTag, dockerHubUsername, dockerHubPassword, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, containerName, hostPort, containerPort, buildPlatform, envVars } = config;
  const fullImageName = `${dockerHubUsername}/${imageName}:${imageTag}`;

  try {
    job.status = 'running';

    // Step 1: Build Docker image
    addLog(job, 'Building Docker image...');
    await dockerService.buildImage(projectPath, fullImageName, buildPlatform, (log) => addLog(job, log));
    addLog(job, `Successfully built image: ${fullImageName}`);

    // Step 2: Push to Docker Hub
    addLog(job, 'Pushing image to Docker Hub...');
    await dockerService.pushImage(fullImageName, dockerHubUsername, dockerHubPassword, (log) => addLog(job, log));
    addLog(job, 'Successfully pushed image to Docker Hub');

    // Step 3: Deploy to server via SSH
    addLog(job, `Connecting to server ${sshHost}...`);
    await sshService.deployContainer(sshHost, sshUser, sshPassword, fullImageName, containerName, hostPort, containerPort, sshPrivateKey, sshPassphrase, envVars, (log) => addLog(job, log));
    addLog(job, 'Deployment completed successfully!');

    job.status = 'completed';
  } catch (error) {
    addLog(job, `ERROR: ${error.message}`);
    job.status = 'failed';
  }
}

function addLog(job, message) {
  const timestamp = new Date().toISOString();
  job.logs.push(`[${timestamp}] ${message}`);
  console.log(`[Job ${job.id}] ${message}`);
}

// Start server
app.listen(PORT, () => {
  console.log(`CI/CD Server running on http://localhost:${PORT}`);
});
