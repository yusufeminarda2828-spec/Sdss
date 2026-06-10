const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Dosya yükleme ayarları
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}_${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// Veritabanı kurulumu
const db = new sqlite3.Database(path.join(__dirname, 'distribution-center.db'), (err) => {
  if (err) {
    console.error('Veritabanı bağlantısı hatası:', err);
  } else {
    console.log('Veritabanı bağlantısı başarılı');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // Dağıtım merkezi meta bilgileri
    db.run(`
      CREATE TABLE IF NOT EXISTS distribution_center (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE,
        is_locked INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        locked_at DATETIME
      )
    `);

    // Yüklenen dosyalar
    db.run(`
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        uploader_ip TEXT,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        file_path TEXT NOT NULL,
        status TEXT DEFAULT 'active'
      )
    `);

    // Çalışma mantığı logları (gizli)
    db.run(`
      CREATE TABLE IF NOT EXISTS logic_logs (
        id TEXT PRIMARY KEY,
        logic_version INTEGER,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        result TEXT,
        hidden INTEGER DEFAULT 1
      )
    `);
  });
}

// ==================== API ENDPOINTS ====================

// 1. Durum kontrolü
app.get('/api/distribution-center/status', (req, res) => {
  db.get(
    'SELECT name, is_locked FROM distribution_center WHERE id = 1',
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Veritabanı hatası' });
      }

      if (!row) {
        return res.json({ isLocked: false, name: null });
      }

      res.json({
        isLocked: row.is_locked === 1,
        name: row.name
      });
    }
  );
});

// 2. İsim belirleme (Sadece bir kez)
app.post('/api/distribution-center/set-name', (req, res) => {
  const { name } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ message: 'İsim boş olamaz' });
  }

  if (name.length > 100) {
    return res.status(400).json({ message: 'İsim çok uzun (max 100 karakter)' });
  }

  // Dağıtım merkezi zaten adlandırıldı mı?
  db.get(
    'SELECT name, is_locked FROM distribution_center WHERE id = 1',
    (err, row) => {
      if (err) {
        return res.status(500).json({ message: 'Veritabanı hatası' });
      }

      if (row && row.is_locked === 1) {
        return res.status(409).json({ 
          message: `Dağıtım merkezi zaten "${row.name}" olarak adlandırıldı ve kilitlendi` 
        });
      }

      // Yeni isim ekle ve kilitle
      const lockedAt = new Date().toISOString();
      db.run(
        'INSERT OR REPLACE INTO distribution_center (id, name, is_locked, locked_at) VALUES (1, ?, 1, ?)',
        [name, lockedAt],
        (err) => {
          if (err) {
            return res.status(500).json({ message: 'İsim kaydedilemedi' });
          }

          // Gizli çalışma mantığını çalıştır - v1
          executeHiddenLogic(1, name);

          res.status(200).json({ 
            message: `Dağıtım merkezi "${name}" olarak adlandırıldı ve kilitlendi`,
            name: name
          });
        }
      );
    }
  );
});

// 3. Dosya yükleme
app.post('/api/distribution-center/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Dosya seçilmedi' });
  }

  // Dağıtım merkezi adlandırıldı mı?
  db.get(
    'SELECT name, is_locked FROM distribution_center WHERE id = 1',
    (err, row) => {
      if (err) {
        return res.status(500).json({ message: 'Veritabanı hatası' });
      }

      if (!row || row.is_locked === 0) {
        fs.unlinkSync(req.file.path); // Dosyayı sil
        return res.status(403).json({ message: 'Dağıtım merkezi henüz adlandırılmamış' });
      }

      // Dosya kurallarını kontrol et
      const fileValidation = validateFile(req.file);
      if (!fileValidation.valid) {
        fs.unlinkSync(req.file.path); // Dosyayı sil
        return res.status(400).json({ message: fileValidation.message });
      }

      // Dosyayı veritabanına kaydet
      const fileId = uuidv4();
      const clientIp = req.ip || req.connection.remoteAddress;

      db.run(
        `INSERT INTO uploads (id, file_name, original_name, file_size, mime_type, uploader_ip, file_path, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        [fileId, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, clientIp, req.file.path],
        (err) => {
          if (err) {
            fs.unlinkSync(req.file.path);
            return res.status(500).json({ message: 'Dosya kaydedilemedi' });
          }

          // Gizli çalışma mantığını çalıştır - v2
          executeHiddenLogic(2, row.name, fileId);

          res.status(200).json({
            message: 'Dosya başarıyla yüklendi',
            fileId: fileId,
            fileName: req.file.originalname,
            size: req.file.size
          });
        }
      );
    }
  );
});

// 4. Yüklenen dosyaları listele
app.get('/api/distribution-center/files', (req, res) => {
  db.all(
    'SELECT id, original_name, file_size, uploaded_at FROM uploads WHERE status = "active" ORDER BY uploaded_at DESC',
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Veritabanı hatası' });
      }

      res.json({ files: rows });
    }
  );
});

// 5. Dosya indir
app.get('/api/distribution-center/download/:fileId', (req, res) => {
  const { fileId } = req.params;

  db.get(
    'SELECT file_path, original_name FROM uploads WHERE id = ? AND status = "active"',
    [fileId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ message: 'Dosya bulunamadı' });
      }

      res.download(row.file_path, row.original_name);
    }
  );
});

// ==================== GİZLİ ÇALIŞMA MANTIKLARI ====================

function executeHiddenLogic(version, centerName, fileId = null) {
  const logId = uuidv4();
  const timestamp = new Date().toISOString();

  if (version === 1) {
    // v1: Merkez adlandırılırken çalışan gizli mantık
    const result = {
      action: 'center_initialized',
      center_name: centerName,
      timestamp: timestamp,
      security_level: 'locked'
    };

    db.run(
      'INSERT INTO logic_logs (id, logic_version, executed_at, result, hidden) VALUES (?, ?, ?, ?, 1)',
      [logId, 1, timestamp, JSON.stringify(result)],
      (err) => {
        if (!err) {
          console.log('🔒 [GİZLİ] v1 Mantığı çalıştırıldı:', centerName);
        }
      }
    );
  } else if (version === 2) {
    // v2: Dosya yüklenmesinde çalışan gizli mantık
    const result = {
      action: 'file_processed',
      file_id: fileId,
      center_name: centerName,
      timestamp: timestamp,
      validation: 'passed',
      processing_status: 'completed'
    };

    db.run(
      'INSERT INTO logic_logs (id, logic_version, executed_at, result, hidden) VALUES (?, ?, ?, ?, 1)',
      [logId, 2, timestamp, JSON.stringify(result)],
      (err) => {
        if (!err) {
          console.log('📦 [GİZLİ] v2 Mantığı çalıştırıldı:', fileId);
        }
      }
    );
  }
}

// ==================== DOSYA KURALLARI ====================

function validateFile(file) {
  // İzin verilen dosya tipleri
  const allowedMimeTypes = [
    'application/zip',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'application/gzip',
    'application/x-tar'
  ];

  const fileExtension = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'];

  // Uzantı kontrolü
  if (!allowedExtensions.includes(fileExtension)) {
    return {
      valid: false,
      message: `İzin verilmeyen dosya tipi: ${fileExtension}`
    };
  }

  // Boyut kontrolü (500MB)
  if (file.size > 500 * 1024 * 1024) {
    return {
      valid: false,
      message: 'Dosya çok büyük (max 500MB)'
    };
  }

  // MIME type kontrolü
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return {
      valid: false,
      message: 'Dosya formatı uygun değil'
    };
  }

  return { valid: true };
}

// ==================== SUNUCU BAŞLAT ====================

app.listen(PORT, () => {
  console.log(`🚀 Dağıtım Merkezi sunucusu ${PORT} portunda çalışıyor`);
  console.log(`📍 URL: http://localhost:${PORT}`);
});

// Veritabanı kapatma
process.on('exit', () => {
  db.close();
});
