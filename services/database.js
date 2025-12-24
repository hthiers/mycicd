const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'root'
};

const DB_NAME = 'cicd_tool';

let pool;

async function initializeDatabase() {
  try {
    // First, connect without database to create it
    const connection = await mysql.createConnection(DB_CONFIG);

    // Create database if it doesn't exist with utf8mb4 charset
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`Database '${DB_NAME}' ready`);

    await connection.end();

    // Now create pool with database and utf8mb4 charset
    pool = mysql.createPool({
      ...DB_CONFIG,
      database: DB_NAME,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    // Create tables
    await createTables();

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
}

async function createTables() {
  const connection = await pool.getConnection();

  try {
    // Migrate existing tables to utf8mb4
    try {
      await connection.query(`ALTER DATABASE ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      console.log('Database charset set to utf8mb4');
    } catch (e) {
      // Ignore if already set
    }

    // Convert existing tables to utf8mb4
    try {
      await connection.query(`ALTER TABLE projects CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      console.log('Converted projects table to utf8mb4');
    } catch (e) {
      // Table doesn't exist yet, will be created below
    }

    try {
      await connection.query(`ALTER TABLE jobs CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      console.log('Converted jobs table to utf8mb4');
    } catch (e) {
      // Table doesn't exist yet, will be created below
    }

    try {
      await connection.query(`ALTER TABLE image_tags CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      console.log('Converted image_tags table to utf8mb4');
    } catch (e) {
      // Table doesn't exist yet, will be created below
    }

    // Check if we need to migrate from JSON to TEXT
    try {
      await connection.query(`
        ALTER TABLE projects MODIFY COLUMN config TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL
      `);
      console.log('Migrated projects.config from JSON to TEXT');
    } catch (e) {
      // Table doesn't exist yet, will be created below
    }

    try {
      await connection.query(`
        ALTER TABLE jobs MODIFY COLUMN logs MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);
      await connection.query(`
        ALTER TABLE jobs MODIFY COLUMN config MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);
      console.log('Migrated jobs columns to MEDIUMTEXT');
    } catch (e) {
      // Table doesn't exist yet, will be created below
    }

    // Projects table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        config TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Jobs table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        status VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        logs MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        config MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_status (status),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Image tags table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS image_tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        image_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        tag VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        job_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_image_key (image_key),
        INDEX idx_tag (tag),
        UNIQUE KEY unique_image_tag (image_key, tag, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('Database tables created/verified');
  } finally {
    connection.release();
  }
}

// Project operations
async function createProject(name, config) {
  const [result] = await pool.query(
    'INSERT INTO projects (name, config) VALUES (?, ?)',
    [name, JSON.stringify(config)]
  );
  return result.insertId;
}

async function updateProject(id, name, config) {
  await pool.query(
    'UPDATE projects SET name = ?, config = ? WHERE id = ?',
    [name, JSON.stringify(config), id]
  );
}

async function getProject(id) {
  const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [id]);
  if (rows.length === 0) return null;

  const project = rows[0];
  return {
    id: project.id,
    name: project.name,
    config: JSON.parse(project.config),
    createdAt: project.created_at,
    updatedAt: project.updated_at
  };
}

async function getAllProjects() {
  const [rows] = await pool.query('SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC');
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function deleteProject(id) {
  await pool.query('DELETE FROM projects WHERE id = ?', [id]);
}

// Job operations
async function createJob(config) {
  const [result] = await pool.query(
    'INSERT INTO jobs (status, logs, config) VALUES (?, ?, ?)',
    ['pending', '', JSON.stringify(config)]
  );
  return result.insertId;
}

async function updateJob(id, status, logs) {
  // Store logs as plain string (joined by newlines) instead of JSON array
  const logsString = Array.isArray(logs) ? logs.join('\n') : logs;
  await pool.query(
    'UPDATE jobs SET status = ?, logs = ? WHERE id = ?',
    [status, logsString, id]
  );
}

async function getJob(id) {
  const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [id]);
  if (rows.length === 0) return null;

  const job = rows[0];
  return {
    id: job.id,
    status: job.status,
    // Parse logs: split string by newlines, filter empty lines
    logs: job.logs ? job.logs.split('\n').filter(line => line.trim() !== '') : [],
    config: JSON.parse(job.config),
    createdAt: job.created_at
  };
}

async function getAllJobs() {
  const [rows] = await pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 3');
  return rows.map(row => ({
    id: row.id,
    status: row.status,
    // Parse logs: split string by newlines, filter empty lines
    logs: row.logs ? row.logs.split('\n').filter(line => line.trim() !== '') : [],
    config: JSON.parse(row.config),
    createdAt: row.created_at
  }));
}

// Image tag operations
async function addImageTag(imageKey, tag, jobId) {
  try {
    await pool.query(
      'INSERT INTO image_tags (image_key, tag, job_id) VALUES (?, ?, ?)',
      [imageKey, tag, jobId]
    );
  } catch (error) {
    // Ignore duplicate entries
    if (error.code !== 'ER_DUP_ENTRY') {
      throw error;
    }
  }
}

async function getImageTags(imageKey) {
  const [rows] = await pool.query(
    'SELECT tag, job_id, created_at FROM image_tags WHERE image_key = ? ORDER BY created_at DESC',
    [imageKey]
  );
  return rows.map(row => ({
    tag: row.tag,
    jobId: row.job_id,
    createdAt: row.created_at
  }));
}

async function tagExists(imageKey, tag) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) as count FROM image_tags WHERE image_key = ? AND tag = ?',
    [imageKey, tag]
  );
  return rows[0].count > 0;
}

module.exports = {
  initializeDatabase,
  createProject,
  updateProject,
  getProject,
  getAllProjects,
  deleteProject,
  createJob,
  updateJob,
  getJob,
  getAllJobs,
  addImageTag,
  getImageTags,
  tagExists
};
