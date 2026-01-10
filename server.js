require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const dockerService = require('./services/docker');
const sshService = require('./services/ssh');
const cryptoService = require('./services/crypto');
const db = require('./services/database');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// In-memory job tracking (for active jobs only)
const activeJobs = new Map();

// API Routes
app.post('/api/deploy', async (req, res) => {
  const { projectPath, dockerfileName, contextPath, imageName, imageTag, dockerHubUsername, dockerHubPassword, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, containerName, hostPort, containerPort, buildPlatform, envVars } = req.body;

  // Validate required fields
  if (!projectPath || !imageName || !imageTag || !dockerHubUsername || !dockerHubPassword || !sshHost || !sshUser || !containerName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate SSH authentication - must have either password or private key
  if (!sshPassword && !sshPrivateKey) {
    return res.status(400).json({ error: 'Either SSH password or SSH private key must be provided' });
  }

  try {
    const config = { projectPath, dockerfileName, contextPath, imageName, imageTag, sshHost, containerName, hostPort, containerPort, buildPlatform };
    const jobId = await db.createJob(config);

    // Store active job in memory for real-time updates
    activeJobs.set(jobId, { status: 'pending', logs: [] });

    res.json({ jobId, message: 'Deployment started' });

    // Run deployment asynchronously
    runDeployment(jobId, { projectPath, dockerfileName, contextPath, imageName, imageTag, dockerHubUsername, dockerHubPassword, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, containerName, hostPort, containerPort, buildPlatform, envVars });
  } catch (error) {
    res.status(500).json({ error: `Failed to create job: ${error.message}` });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await db.getAllJobs();

    // Merge in-memory active job data with database data
    const mergedJobs = jobs.map(job => {
      const activeJob = activeJobs.get(job.id);
      if (activeJob) {
        // Use in-memory data for active jobs (more up-to-date)
        return {
          ...job,
          status: activeJob.status,
          logs: activeJob.logs
        };
      }
      return job;
    });

    res.json(mergedJobs);
  } catch (error) {
    res.status(500).json({ error: `Failed to fetch jobs: ${error.message}` });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    const job = await db.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if job is active in memory (has more up-to-date logs)
    const activeJob = activeJobs.get(jobId);
    if (activeJob) {
      return res.json({
        ...job,
        status: activeJob.status,
        logs: activeJob.logs
      });
    }

    res.json(job);
  } catch (error) {
    res.status(500).json({ error: `Failed to fetch job: ${error.message}` });
  }
});

// Project Management API Routes

// Get all projects (without decrypted sensitive data)
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await db.getAllProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: `Failed to fetch projects: ${error.message}` });
  }
});

// Create or update project
app.post('/api/projects', async (req, res) => {
  const { id, name, masterPassword, config } = req.body;

  if (!name || !masterPassword || !config) {
    return res.status(400).json({ error: 'Missing required fields: name, masterPassword, config' });
  }

  try {
    // Encrypt sensitive fields
    const encryptedConfig = {
      projectPath: config.projectPath,
      dockerfileName: config.dockerfileName,
      contextPath: config.contextPath,
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
      const existingProject = await db.getProject(parseInt(id));
      if (!existingProject) {
        return res.status(404).json({ error: 'Project not found' });
      }
      await db.updateProject(parseInt(id), name, encryptedConfig);
      res.json({ id: parseInt(id), message: 'Project updated successfully' });
    } else {
      // Create new project
      const newId = await db.createProject(name, encryptedConfig);
      res.json({ id: newId, message: 'Project created successfully' });
    }
  } catch (error) {
    res.status(500).json({ error: `Failed to save project: ${error.message}` });
  }
});

// Get project by ID and decrypt
app.post('/api/projects/:id/decrypt', async (req, res) => {
  const { masterPassword } = req.body;

  if (!masterPassword) {
    return res.status(400).json({ error: 'Master password required' });
  }

  try {
    const project = await db.getProject(parseInt(req.params.id));

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Decrypt sensitive fields
    const decryptedConfig = {
      projectPath: project.config.projectPath,
      dockerfileName: project.config.dockerfileName,
      contextPath: project.config.contextPath,
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
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const project = await db.getProject(parseInt(req.params.id));

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await db.deleteProject(parseInt(req.params.id));
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: `Failed to delete project: ${error.message}` });
  }
});

// Image Tag History API Routes

// Get tag history for a specific image
app.get('/api/tags/:username/:imageName', async (req, res) => {
  try {
    const imageKey = `${req.params.username}/${req.params.imageName}`;
    const tags = await db.getImageTags(imageKey);
    res.json(tags);
  } catch (error) {
    res.status(500).json({ error: `Failed to fetch tags: ${error.message}` });
  }
});

// Check if a specific tag exists for an image
app.get('/api/tags/:username/:imageName/:tag/exists', async (req, res) => {
  try {
    const imageKey = `${req.params.username}/${req.params.imageName}`;
    const exists = await db.tagExists(imageKey, req.params.tag);
    res.json({ exists, tag: req.params.tag, image: imageKey });
  } catch (error) {
    res.status(500).json({ error: `Failed to check tag: ${error.message}` });
  }
});

// Deployment function
async function runDeployment(jobId, config) {
  const { projectPath, dockerfileName, contextPath, imageName, imageTag, dockerHubUsername, dockerHubPassword, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, containerName, hostPort, containerPort, buildPlatform, envVars } = config;
  const fullImageName = `${dockerHubUsername}/${imageName}:${imageTag}`;

  // Get active job from memory
  const job = activeJobs.get(jobId);
  if (!job) return;

  try {
    job.status = 'running';
    await updateJobInDB(jobId, job.status, job.logs);

    // Step 1: Build Docker image
    addLog(jobId, 'Building Docker image...');
    await dockerService.buildImage(projectPath, fullImageName, buildPlatform, dockerfileName, contextPath, (log) => addLog(jobId, log));
    addLog(jobId, `Successfully built image: ${fullImageName}`);

    // Step 2: Push to Docker Hub
    addLog(jobId, 'Pushing image to Docker Hub...');
    await dockerService.pushImage(fullImageName, dockerHubUsername, dockerHubPassword, (log) => addLog(jobId, log));
    addLog(jobId, 'Successfully pushed image to Docker Hub');

    // Step 3: Deploy to server via SSH
    addLog(jobId, `Connecting to server ${sshHost}...`);
    await sshService.deployContainer(sshHost, sshUser, sshPassword, fullImageName, containerName, hostPort, containerPort, sshPrivateKey, sshPassphrase, envVars, (log) => addLog(jobId, log));
    addLog(jobId, 'Deployment completed successfully!');

    job.status = 'completed';
    await updateJobInDB(jobId, job.status, job.logs);

    // Record tag in history
    const imageKey = `${dockerHubUsername}/${imageName}`;
    await db.addImageTag(imageKey, imageTag, jobId);

    // Remove from active jobs
    activeJobs.delete(jobId);
  } catch (error) {
    addLog(jobId, `ERROR: ${error.message}`);
    job.status = 'failed';
    await updateJobInDB(jobId, job.status, job.logs);
    activeJobs.delete(jobId);
  }
}

function addLog(jobId, message) {
  const job = activeJobs.get(jobId);
  if (job) {
    job.logs.push(message);
  }
  console.log(`[Job ${jobId}] ${message}`);
}

async function updateJobInDB(jobId, status, logs) {
  try {
    await db.updateJob(jobId, status, logs);
  } catch (error) {
    console.error(`Failed to update job ${jobId} in database:`, error);
  }
}

// Initialize database and start server
async function startServer() {
  try {
    await db.initializeDatabase();
    app.listen(PORT, () => {
      console.log(`CI/CD Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
