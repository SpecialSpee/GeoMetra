// ============================================================
// 06-persistence.js — Сохранение/загрузка весов, IndexedDB,
//                     inspectWeights(), reset()
// ============================================================
"use strict";

Object.assign(window.GnnAI, {

  // === Сохранение весов (основной метод) ===
saveWeights: async function() {
  // 🔥 Даём браузеру отрисовать кадр перед блокирующим чтением
  await new Promise(r => setTimeout(r, 50));
    if (!this.vars || this.vars.length === 0) return;

    // Защита: если WebGL контекст мёртв — не читаем тензоры
    if (tf.getBackend() === 'webgl') {
      try {
        const canvas = document.querySelector('canvas');
        if (canvas) {
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (gl && gl.isContextLost()) {
            console.error("[GnnAI] 💥 WebGL контекст мёртв, сохранение отменено");
            this.isSaving = false;
            return;
          }
        }
      } catch (e) {}
    }

    // Защита от NaN/Inf
    let hasInvalidWeights = false;
    for (const v of this.vars) {
      const data = v.dataSync();
      for (let i = 0; i < data.length; i++) {
        if (!isFinite(data[i])) { hasInvalidWeights = true; break; }
      }
      if (hasInvalidWeights) break;
    }
    if (hasInvalidWeights) {
      console.error("[GnnAI] ❌ NaN/Inf в весах! Сохранение пропущено.");
      return;
    }

    try {
      console.log(`[GnnAI] 💾 Сохранение весов (Batch: ${this.trainBatches})...`);

      // ЯДЕРНЫЙ ФИКС: переключение на CPU для безопасного dataSync
      const originalBackend = tf.getBackend();
      if (originalBackend !== 'cpu') {
        console.log("[GnnAI] 🔄 Временное переключение на CPU...");
        await tf.setBackend('cpu');
        await tf.ready();
      }

      const mainData = this.vars.map(v => ({
        shape: v.shape,
        values: Array.from(v.dataSync())
      }));
      const targetData = this.targetVars ? this.targetVars.map(v => ({
        shape: v.shape,
        values: Array.from(v.dataSync())
      })) : [];

      if (originalBackend !== 'cpu') {
        console.log(`[GnnAI] 🔄 Возврат на backend: ${originalBackend}`);
        await tf.setBackend(originalBackend);
        await tf.ready();
      }

      const payload = {
        version: 7.7,
        batches: this.trainBatches,
        data: { main: mainData, target: targetData },
        backend: tf.getBackend(),
        actionsCount: G_ACTIONS.length,
        nodeFeatures: CFG.NODE_FEATURES,
        savedAt: Date.now()
      };

      if (!this.db) await this.initWeightDB();

      const tx = this.db.transaction('models', 'readwrite');
      const store = tx.objectStore('models');
      store.put(payload, CFG.STORAGE_KEY);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
      console.log(`[GnnAI] ✅ Веса сохранены в IndexedDB!`);

      // Фиксируем "тень" весов для дельты
      try {
        let l2Sum = 0;
        for (const v of this.vars) {
          const data = v.dataSync();
          for (let i = 0; i < data.length; i++) {
            if (isFinite(data[i])) l2Sum += data[i] * data[i];
          }
        }
        this.lastWeightSnapshot = {
          l2: Math.sqrt(l2Sum),
          timestamp: Date.now(),
          batches: this.trainBatches
        };
      } catch (e) {
        console.warn("[GnnAI] ⚠️ Не удалось зафиксировать тень весов:", e);
      }
    } catch (e) {
      console.error("[GnnAI] ❌ Ошибка сохранения:", e);
      // Fallback в localStorage
      try {
        const backup = this.vars.map(v => ({
          shape: v.shape,
          values: Array.from(v.dataSync()).filter(isFinite)
        }));
        localStorage.setItem(CFG.STORAGE_KEY + '_emergency_backup', JSON.stringify({
          version: 7.7, batches: this.trainBatches, data: { main: backup }, timestamp: Date.now()
        }));
      } catch (e2) {}
    } finally {
      this.isSaving = false;
    }
  },

  // === Fallback-сохранение (CPU-only) ===
  _saveWeightsFallback: async function() {
    console.log("[GnnAI] 🔄 Fallback сохранение...");
    try {
      const originalBackend = tf.getBackend();
      await tf.setBackend('cpu');
      await tf.ready();

      const mainData = this.vars.map(v => ({
        shape: v.shape,
        values: Array.from(v.dataSync())
      }));
      const targetData = this.targetVars ? this.targetVars.map(v => ({
        shape: v.shape,
        values: Array.from(v.dataSync())
      })) : [];

      const payload = {
        version: 7.7,
        batches: this.trainBatches,
        data: { main: mainData, target: targetData },
        backend: 'cpu-fallback',
        actionsCount: G_ACTIONS.length,
        nodeFeatures: CFG.NODE_FEATURES,
        savedAt: Date.now()
      };

      await tf.setBackend(originalBackend);
      await tf.ready();

      if (this.db) {
        const tx = this.db.transaction('models', 'readwrite');
        tx.objectStore('models').put(payload, CFG.STORAGE_KEY);
        console.log(`[GnnAI] 💾 Fallback: веса в IndexedDB (batch: ${this.trainBatches})`);
      } else {
        localStorage.setItem(CFG.STORAGE_KEY + '_backup', JSON.stringify(payload));
        console.log(`[GnnAI] 💾 Fallback: веса в localStorage`);
      }
    } catch (e) {
      console.error("[GnnAI] ❌ Fallback не сработал:", e);
      try {
        localStorage.setItem(CFG.STORAGE_KEY + '_metadata', JSON.stringify({
          version: 7.7, batches: this.trainBatches,
          error: e.message, timestamp: Date.now()
        }));
      } catch (e2) {}
    }
  },

  // === Прямой сохранитель в IndexedDB ===
  _saveToIndexedDB: async function(payload) {
    return new Promise((resolve, reject) => {
      const DB_NAME = 'GnnAI_Weights_DB';
      const STORE = 'models';
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(payload, CFG.STORAGE_KEY);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = (ev) => { db.close(); reject(ev.target.error); };
        } catch (err) {
          db.close();
          reject(err);
        }
      };
      req.onerror = (e) => reject(req.error);
    });
  },

  // === Загрузка весов ===
  loadWeights: async function () {
    try {
      let obj = null;

      // 1. Fallback: прямое чтение из IndexedDB
      obj = await this._loadFromIndexedDB();

      // 2. Fallback: localStorage backup
      if (!obj) {
        const backup = localStorage.getItem(CFG.STORAGE_KEY + '_backup');
        if (backup) {
          try {
            obj = JSON.parse(backup);
            console.log("[GnnAI] ✅ Загружено из localStorage backup");
          } catch (e) {
            console.warn("[GnnAI] ⚠️ backup повреждён");
          }
        }
      }

      if (!obj) {
        console.log("[GnnAI] Записей не найдено. Инициализация с нуля.");
        return false;
      }

      const mainData = obj.data?.main || obj.data;
      if (!Array.isArray(mainData)) {
        console.warn("[GnnAI] Ошибка формата данных");
        return false;
      }
      if (mainData.length !== this.vars.length) {
        console.warn(`[GnnAI] Несовпадение архитектуры: ${mainData.length} vs ${this.vars.length}`);
        return false;
      }
      if (obj.actionsCount && obj.actionsCount !== G_ACTIONS.length) {
        console.warn(`[GnnAI] ⚠️ Старая архитектура (${obj.actionsCount} действий). Сброс.`);
        return false;
      }
      if (obj.nodeFeatures && obj.nodeFeatures !== CFG.NODE_FEATURES) {
        console.warn(`[GnnAI] ⚠️ Несовпадение NODE_FEATURES: ${obj.nodeFeatures} vs ${CFG.NODE_FEATURES}. Сброс.`);
        return false;
      }

      const shapeMismatch = mainData.some((w, i) => {
        if (!this.vars[i]) return true;
        return w.shape.join(',') !== this.vars[i].shape.join(',');
      });
      if (shapeMismatch) {
        console.warn("[GnnAI] ⚠️ Shapes не совпадают. Сброс.");
        return false;
      }

      const checkInvalid = (arr) => arr && arr.some(w => w.values.some(v => !isFinite(v)));
      if (checkInvalid(mainData) || checkInvalid(obj.data?.target)) {
        console.warn("[GnnAI] ⚠️ Веса повреждены (NaN/Inf). Сброс.");
        return false;
      }

      // Применяем веса
      tf.tidy(() => {
        mainData.forEach((w, i) => {
          if (this.vars[i]) this.vars[i].assign(tf.tensor(w.values, w.shape));
        });
        const targetData = obj.data?.target;
        if (targetData && this.targetVars) {
          targetData.forEach((w, i) => {
            if (this.targetVars[i]) this.targetVars[i].assign(tf.tensor(w.values, w.shape));
          });
        } else if (this.targetVars) {
          this.vars.forEach((v, i) => this.targetVars[i].assign(v.clone()));
        }
      });

      this.trainBatches = obj.batches || 0;

      // Фиксируем "тень" весов
      try {
        let l2Sum = 0;
        for (const v of this.vars) {
          const data = v.dataSync();
          for (let i = 0; i < data.length; i++) {
            if (isFinite(data[i])) l2Sum += data[i] * data[i];
          }
        }
        this.lastWeightSnapshot = {
          l2: Math.sqrt(l2Sum),
          timestamp: Date.now(),
          batches: this.trainBatches
        };
        console.log(`[GnnAI] 🌑 Тень весов загружена (L2=${Math.sqrt(l2Sum).toFixed(2)})`);
      } catch (e) {
        console.warn("[GnnAI] ⚠️ Не удалось зафиксировать тень:", e);
      }

      console.log(`[GnnAI] ✅ Веса загружены (batch: ${this.trainBatches})`);
      return true;
    } catch (e) {
      console.error("[GnnAI] Ошибка загрузки:", e);
      return false;
    }
  },

  // === Чтение из IndexedDB ===
  _loadFromIndexedDB: async function() {
    return new Promise((resolve) => {
      const DB_NAME = 'GnnAI_Weights_DB';
      const STORE = 'models';
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        try {
          const tx = db.transaction(STORE, 'readonly');
          const getReq = tx.objectStore(STORE).get(CFG.STORAGE_KEY);
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || null); };
          getReq.onerror = () => { db.close(); resolve(null); };
        } catch (err) {
          db.close();
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  },

  // === Инспекция весов (отладка) ===
  inspectWeights: function () {
    if (!this.vars || this.vars.length === 0) {
      console.warn("[GnnAI] Веса ещё не инициализированы.");
      return;
    }
    console.group("🧠 [GnnAI] РЕНТГЕН МОЗГА");
    let totalParams = 0, totalZero = 0, totalInf = 0;
    let maxWeight = -Infinity, minWeight = Infinity;

    this.vars.forEach((v, i) => {
      const data = v.dataSync();
      const shape = v.shape.join('x');
      let layerZero = 0, layerInf = 0;
      let layerMax = -Infinity, layerMin = Infinity, layerSum = 0;
      for (let j = 0; j < data.length; j++) {
        const val = data[j];
        totalParams++;
        layerSum += val;
        if (val === 0) layerZero++;
        if (!isFinite(val)) layerInf++;
        if (val > layerMax) layerMax = val;
        if (val < layerMin) layerMin = val;
        if (val > maxWeight) maxWeight = val;
        if (val < minWeight) minWeight = val;
      }
      totalZero += layerZero;
      totalInf += layerInf;
      const avg = layerSum / data.length;
      console.log(`Слой ${i} (${shape}): Ср=${avg.toFixed(4)} | Мин=${layerMin.toFixed(2)} | Макс=${layerMax.toFixed(2)} | Нулей=${layerZero}`);
    });

    console.log(`📊 ИТОГО: ${totalParams} параметров.`);
    console.log(`⚠️ Бесконечностей (NaN/Inf): ${totalInf}`);
    console.log(`📉 Диапазон весов: от ${minWeight.toFixed(4)} до ${maxWeight.toFixed(4)}`);

    if (totalInf > 0) console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: В сети есть бесконечности! Нужен сброс.");
    else if (Math.abs(maxWeight) > 100) console.warn("⚠️ ВНИМАНИЕ: Очень большие веса. Возможен взрыв градиента.");
    else if (Math.abs(maxWeight) < 0.001 && totalParams > 1000) console.warn("⚠️ ВНИМАНИЕ: Веса стремятся к нулю. Сеть 'схлопнулась'.");
    else console.log("✅ Сеть выглядит здоровой.");
    console.groupEnd();
  },

  // === Полный сброс весов и памяти ===
  reset: function () {
    console.log("[GnnAI] 🧹 Сброс весов и очистка памяти...");

    this.vars = [];
    this.targetVars = [];
    this.model = null;
    this.optimizer = null;
    this.replay = new this._RingBuffer(CFG.REPLAY_SIZE);

    if (this.db) {
      try { this.db.close(); } catch (e) {}
      this.db = null;
    }

    const req = indexedDB.deleteDatabase('GnnAI_Weights_DB');
    req.onsuccess = () => {
      console.log("[GnnAI] ✅ База данных удалена. Перезагрузка...");
      location.reload();
    };
    req.onerror = () => {
      console.error("[GnnAI] ❌ Ошибка удаления БД, пробуем перезагрузку anyway");
      location.reload();
    };
    req.onblocked = () => {
      console.warn("[GnnAI] ⚠️ Удаление заблокировано другой вкладкой? Перезагрузка...");
      location.reload();
    };
  }

});