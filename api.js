
const express = require("express");
const fs      = require("fs");
const path    = require("path");
const multer  = require("multer");

const app = express();
app.use(express.json());

const PORT  = 3000;
const MODEL_DIR = path.join(__dirname, "models");
fs.mkdirSync(MODEL_DIR, { recursive: true });

// CORS и логирование запросов
app.use((req, res, next) => {
  console.log(`→ [${new Date().toISOString()}] ${req.method} ${req.url}`);
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Headers","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Статический эндпоинт для отдачи файлов модели
app.use("/models", express.static(MODEL_DIR));

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: MODEL_DIR,
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

// Загрузка новой модели
// Корректная загрузка нескольких файлов (json и bin)
app.post("/models", upload.any(), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Нет файлов" });
  }
  req.files.forEach(file => {
    console.log(`✅ Сохранён файл: ${file.originalname}`);
  });
  res.json({ success: true });
});



// Удаление текущей модели
app.delete("/models", (req, res) => {
  const { password } = req.body;
  if (password !== "reset") {
    return res.status(403).json({ error: "Неверный пароль" });
  }

  const filesToDelete = [
    "model.json",
    "model.weights.bin",
    "trainingData.json",
    "trainingStats.json",
    "combatMemory.json",
    "scoreCache.json",
    "actionHistory.log"
  ];

  const deleted = [];

  for (const file of filesToDelete) {
    const filePath = path.join(MODEL_DIR, file);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted.push(file);
      }
    } catch (err) {
      console.warn(`Не удалось удалить ${file}:`, err.message);
    }
  }

  res.json({ success: true, deleted });
});


// Запуск сервера
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

setInterval(() => {
  console.log("🟢 [KEEPALIVE] Model server is alive at", new Date().toISOString());
}, 60_000);

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});
