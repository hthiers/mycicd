const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const dockerService = require('./services/docker');
const sshService = require('./services/ssh');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory job storage
const jobs = [];
let jobIdCounter = 1;

// API Routes
app.post('/api/deploy', async (req, res) => {
  const { projectPath, imageName, imageTag, dockerHubUsername, dockerHubPassword, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, containerName, hostPort, containerPort, buildPlatform } = req.body;

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
  runDeployment(job, { projectPath, imageName, imageTag, dockerHubUsername, dockerHubPassword, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, containerName, hostPort, containerPort, buildPlatform });
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

// Deployment function
async function runDeployment(job, config) {
  const { projectPath, imageName, imageTag, dockerHubUsername, dockerHubPassword, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, containerName, hostPort, containerPort, buildPlatform } = config;
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
    await sshService.deployContainer(sshHost, sshUser, sshPassword, fullImageName, containerName, hostPort, containerPort, sshPrivateKey, sshPassphrase, (log) => addLog(job, log));
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
