const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(express.static('public'));

const uploadsDir = path.join(__dirname, 'uploads');
const kernelDir = path.join(__dirname, 'kernel-builds');

[uploadsDir, kernelDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});

const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const db = new sqlite3.Database(path.join(__dirname, 'distribution.db'), (err) => {
  if (err) console.error('Database error:', err);
  else initDatabase();
});

function initDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS centers (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      locked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      locked_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS kernel_versions (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      signature TEXT NOT NULL,
      checksum TEXT NOT NULL,
      binary_path TEXT NOT NULL,
      size INTEGER,
      downloads INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS kernel_builds (
      id TEXT PRIMARY KEY,
      kernel_id TEXT NOT NULL,
      build_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      source_code TEXT,
      compilation_log TEXT,
      status TEXT,
      FOREIGN KEY(kernel_id) REFERENCES kernel_versions(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      size INTEGER,
      path TEXT NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS system_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT,
      hidden INTEGER DEFAULT 1
    )`);
  });
}

// Çekirdek derleyici
class KernelCompiler {
  static generateSourceCode(version) {
    const code = `/* Ant Kernel - ${version} */
#include <stdint.h>

typedef struct {
  uint32_t magic;
  uint8_t version_major;
  uint8_t version_minor;
  uint8_t version_patch;
  uint32_t timestamp;
  uint32_t checksum;
  uint8_t core0_lock;
  uint8_t panic_prevention;
  uint8_t hardware_filter;
  uint8_t digital_prison;
} kernel_header_t;

void kernel_init() {
  asm volatile("cli");
  kernel_header_t header;
  header.magic = 0x4B415249;
  header.core0_lock = 1;
  header.panic_prevention = 1;
  header.hardware_filter = 1;
  header.digital_prison = 1;
}

void zero_panic_engine() {
  __asm__ __volatile__(
    "mov %%eax, %%ebx\\n\\t"
    "xor %%ecx, %%ecx\\n\\t"
    : : : "eax", "ebx", "ecx"
  );
}

void hardware_filter() {
  volatile uint32_t *ram_status = (uint32_t *)0x40000000;
  *ram_status = 0xFFFFFFFF;
}

int main() {
  kernel_init();
  zero_panic_engine();
  hardware_filter();
  return 0;
}`;
    return code;
  }

  static compileToBinary(sourceCode, version) {
    const header = Buffer.alloc(32);
    header.writeUInt32BE(0x4B415249, 0); // KARI magic
    header.writeUInt8(1, 4); // version major
    header.writeUInt8(0, 5); // version minor
    header.writeUInt8(0, 6); // version patch
    header.writeUInt32BE(Date.now(), 8); // timestamp
    header.writeUInt8(1, 12); // core0_lock
    header.writeUInt8(1, 13); // panic_prevention
    header.writeUInt8(1, 14); // hardware_filter
    header.writeUInt8(1, 15); // digital_prison

    const code = Buffer.from(sourceCode);
    const padding = Buffer.alloc(256 - (header.length + code.length));

    return Buffer.concat([header, code, padding]);
  }

  static sign(binary) {
    return crypto.createHash('sha256').update(binary).digest('hex');
  }

  static checksum(binary) {
    return crypto.createHash('md5').update(binary).digest('hex');
  }

  static compile(version) {
    try {
      const sourceCode = this.generateSourceCode(version);
      const binary = this.compileToBinary(sourceCode, version);
      const signature = this.sign(binary);
      const checksum = this.checksum(binary);

      return {
        success: true,
        binary,
        sourceCode,
        signature,
        checksum,
        size: binary.length,
        message: `Kernel ${version} compiled successfully`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

// Endpoints

app.get('/api/center/status', (req, res) => {
  db.get('SELECT name, locked FROM centers WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!row) return res.json({ locked: false, name: null });
    res.json({ locked: row.locked === 1, name: row.name });
  });
});

app.post('/api/center/initialize', (req, res) => {
  const { name } = req.body;

  if (!name || name.length === 0) {
    return res.status(400).json({ error: 'Name required' });
  }

  db.get('SELECT locked FROM centers WHERE id = 1', (err, row) => {
    if (row && row.locked === 1) {
      return res.status(409).json({ error: 'Center already locked' });
    }

    const lockedAt = new Date().toISOString();
    db.run(
      'INSERT OR REPLACE INTO centers (id, name, locked, locked_at) VALUES (1, ?, 1, ?)',
      [name, lockedAt],
      () => {
        const logId = uuidv4();
        db.run(
          'INSERT INTO system_logs (id, action, metadata, hidden) VALUES (?, ?, ?, 1)',
          [logId, 'center_init', JSON.stringify({ name, timestamp: lockedAt })]
        );

        res.json({ status: 'success', name });
      }
    );
  });
});

app.post('/api/kernel/compile', (req, res) => {
  const { version } = req.body;

  if (!version) {
    return res.status(400).json({ error: 'Version required' });
  }

  const compilation = KernelCompiler.compile(version);

  if (!compilation.success) {
    return res.status(500).json({ error: compilation.error });
  }

  const kernelId = uuidv4();
  const binaryPath = path.join(kernelDir, `${kernelId}.bin`);

  fs.writeFileSync(binaryPath, compilation.binary);

  db.run(
    `INSERT INTO kernel_versions 
     (id, version, signature, checksum, binary_path, size, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [kernelId, version, compilation.signature, compilation.checksum, binaryPath, compilation.size],
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to save kernel' });
      }

      const buildId = uuidv4();
      db.run(
        `INSERT INTO kernel_builds 
         (id, kernel_id, source_code, compilation_log, status) 
         VALUES (?, ?, ?, ?, ?)`,
        [buildId, kernelId, compilation.sourceCode, 'Compilation successful', 'completed'],
        () => {
          const logId = uuidv4();
          db.run(
            'INSERT INTO system_logs (id, action, metadata, hidden) VALUES (?, ?, ?, 1)',
            [logId, 'kernel_built', JSON.stringify({ version, signature: compilation.signature })]
          );

          res.status(201).json({
            status: 'success',
            message: `Kernel ${version} compiled and saved`,
            kernel: {
              id: kernelId,
              version,
              signature: compilation.signature.substring(0, 16) + '...',
              checksum: compilation.checksum.substring(0, 16) + '...',
              size: compilation.size,
              binaryPath: binaryPath,
              sourceCode: compilation.sourceCode
            }
          });
        }
      );
    }
  );
});

app.get('/api/kernel/list', (req, res) => {
  db.all(
    'SELECT id, version, signature, checksum, size, downloads, created_at FROM kernel_versions ORDER BY created_at DESC',
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });

      const kernels = (rows || []).map(row => ({
        id: row.id,
        version: row.version,
        signature: row.signature.substring(0, 16) + '...',
        checksum: row.checksum.substring(0, 16) + '...',
        size: row.size,
        downloads: row.downloads,
        createdAt: row.created_at
      }));

      res.json({ kernels });
    }
  );
});

app.get('/api/kernel/download/:kernelId', (req, res) => {
  const { kernelId } = req.params;
  const clientIp = req.ip;

  db.get(
    'SELECT binary_path, version, signature FROM kernel_versions WHERE id = ?',
    [kernelId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: 'Kernel not found' });
      }

      db.run('UPDATE kernel_versions SET downloads = downloads + 1 WHERE id = ?', [kernelId]);

      const logId = uuidv4();
      db.run(
        'INSERT INTO system_logs (id, action, metadata, hidden) VALUES (?, ?, ?, 1)',
        [logId, 'kernel_download', JSON.stringify({ kernelId, ip: clientIp, timestamp: new Date().toISOString() })]
      );

      const binary = fs.readFileSync(row.binary_path);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="ant-core-${row.version}.bin"`);
      res.setHeader('X-Signature', row.signature);
      res.send(binary);
    }
  );
});

app.get('/api/kernel/source/:kernelId', (req, res) => {
  const { kernelId } = req.params;

  db.get(
    'SELECT source_code FROM kernel_builds WHERE kernel_id = ?',
    [kernelId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: 'Source not found' });
      }

      res.setHeader('Content-Type', 'text/plain');
      res.send(row.source_code);
    }
  );
});

app.post('/api/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const fileId = uuidv4();
  db.run(
    'INSERT INTO files (id, filename, original_name, size, path) VALUES (?, ?, ?, ?, ?)',
    [fileId, req.file.filename, req.file.originalname, req.file.size, req.file.path],
    (err) => {
      if (err) {
        fs.unlinkSync(req.file.path);
        return res.status(500).json({ error: 'Upload failed' });
      }
      res.status(201).json({ fileId, filename: req.file.originalname, size: req.file.size });
    }
  );
});

app.get('/api/files/list', (req, res) => {
  db.all(
    'SELECT id, original_name, size, uploaded_at FROM files ORDER BY uploaded_at DESC',
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ files: rows || [] });
    }
  );
});

app.listen(PORT, () => {
  console.log(`Distribution Center running on port ${PORT}`);
  console.log(`Ant Kernel Compiler integrated`);
});

process.on('exit', () => db.close());
