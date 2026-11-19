// ============================================================
// 01-core.js — Ядро: init(), predictData(), tick(), assessThreats()
// ============================================================
"use strict";

Object.assign(window.GnnAI, {

  // === DPS юнитов ===
  getUnitDps: function(type) {
    const dps = { fighter: 15, assault: 35, elite: 60, turret: 20, turret2: 40, turret3: 70, worker: 0, repairman: 0 };
    return dps[type] || 0;
  },

  // === Ценность юнита/здания ===
  getUnitValue: function(type) {
    const values = {
      worker: 10, repairman: 15, fighter: 30, assault: 60, elite: 120,
      turret: 40, turret2: 60, turret3: 80,
      base: 500, base2: 600, base3: 800,
      barracks: 50, warehouse: 30, repairWorkshop: 30, beacon: 40
    };
    return values[type] || 20;
  },

  // === Инициализация БД ===
  initWeightDB: async function () {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('GnnAI_Weights_DB', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('models')) {
          db.createObjectStore('models');
          console.log("[GnnAI] 🗄️ Таблица 'models' создана в IndexedDB.");
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        console.log("[GnnAI] ✅ IndexedDB инициализирована.");
        resolve();
      };
      req.onerror = (e) => {
        console.error("[GnnAI] ❌ Ошибка инициализации IndexedDB:", e.target.error);
        reject(e.target.error);
      };
    });
  },

  // === Главная инициализация ===
  init: async function () {
    if (this.initialized) return;
    if (this._initializing) {
      while (this._initializing) await new Promise(r => setTimeout(r, 50));
      return;
    }
    this._initializing = true;

    if (!window.tf) {
      console.error("[GnnAI] TF.js не найден");
      this._initializing = false;
      return;
    }

    try {
      await tf.setBackend('webgpu').catch(() => tf.setBackend('webgl'));
      await tf.ready();
    } catch (e) {
      console.warn("[GnnAI] Backend fallback", e);
      try {
        await tf.setBackend('webgl');
        await tf.ready();
      } catch (e2) {
        console.error("[GnnAI] Нет доступного backend", e2);
        this._initializing = false;
        return;
      }
    }

    // Страж на Canvas
    const canvas = document.querySelector('canvas');
    if (canvas) {
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        console.error("[GnnAI] 💥 WebGL контекст потерян!");
        setTimeout(() => {
          const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          if (!gl || gl.isContextLost()) {
            console.error("[GnnAI] ❌ Контекст не восстановился. Перезагрузка...");
            location.reload();
          } else {
            console.log("[GnnAI] ✅ Контекст восстановлен");
          }
        }, 2000);
      });
      canvas.addEventListener('webglcontextrestored', () => {
        console.log("[GnnAI] ✅ webglcontextrestored");
      });
    }

    // БД ДО модели
    await this.initWeightDB();

    // Создание весов
    const H = CFG.HIDDEN;
    const F = CFG.NODE_FEATURES;
    const G = CFG.GLOBAL_FEATURES;
    const A = G_ACTIONS.length;
    const v = (shape, scale = 0.08) => tf.variable(tf.randomNormal(shape, 0, scale));

    const W_attn = v([F * 2, 1]);
    const W1 = v([F, H]), b1 = tf.variable(tf.zeros([H]));
    const W2 = v([H, H]), b2 = tf.variable(tf.zeros([H]));
    const Wp = v([H + G, H]), bp = tf.variable(tf.zeros([H]));
    const W_adv = v([H, A]);
    const b_adv = tf.variable(tf.zeros([A]));
    const W_val = v([H, 1]);
    const b_val = tf.variable(tf.zeros([1]));

    this.vars = [W_attn, W1, b1, W2, b2, Wp, bp, W_adv, b_adv, W_val, b_val];
    this.targetVars = this.vars.map(v => tf.variable(v.clone()));
    this.optimizer = tf.train.adam(CFG.LR);
    this.tau = 0.005;

    // Модель
    this.model = {
      forwardBatch: (x, adj_dist, adj_threat, globalBatchTensor) => {
        return tf.tidy(() => {
          const B = x.shape[0];
          const N = CFG.MAX_NODES;
          const xExpanded = x.tile([1, 1, N]).reshape([B, N, N, F]);
          const xTransposed = x.expandDims(2).tile([1, 1, N, 1]);
          const pairFeat = tf.concat([xExpanded, xTransposed], 3).reshape([B * N * N, F * 2]);
          const attnLogits = tf.matMul(pairFeat, W_attn).reshape([B, N, N]);
          const attnWeights = tf.softmax(attnLogits, 2);
          const combinedAdj = tf.add(
            tf.mul(adj_dist, attnWeights),
            tf.mul(adj_threat, attnWeights)
          );
          const agg1 = tf.matMul(combinedAdj, x);
          const h1 = tf.relu(tf.matMul(agg1.reshape([B * N, F]), W1).add(b1).reshape([B, N, H]));
          const agg2 = tf.matMul(combinedAdj, h1);
          const h2 = tf.relu(tf.matMul(agg2.reshape([B * N, H]), W2).add(b2).reshape([B, N, H]));
          const mask = x.slice([0, 0, 0], [B, N, 1]);
          const pooled = h2.mul(mask).sum(1).div(tf.maximum(mask.sum(1), 1));
          const combined = tf.concat([pooled, globalBatchTensor], 1);
          const hp = tf.tanh(tf.add(tf.matMul(combined, Wp), bp));
          const advantage = tf.add(tf.matMul(hp, W_adv), b_adv);
          const value = tf.add(tf.matMul(hp, W_val), b_val);
          const meanAdv = advantage.mean(1, true);
          const logits = value.add(advantage.sub(meanAdv));
          return { logits, value };
        });
      }
    };

    await this.loadWeights();
    this.initialized = true;
    this._initializing = false;
    console.log(`[GnnAI] ✅ Модель (v7.7) готова. Backend: ${tf.getBackend()}`);
  },

  // === Инференс ===
  predictData: function (state) {
    if (!this.model) return null;
    return tf.tidy(() => {
      const globalFeatures = this.getGlobalFeatures();
      const x = tf.tensor2d(state.X).expandDims(0);
      const a_dist = tf.tensor2d(state.A_distance).expandDims(0);
      const a_threat = tf.tensor2d(state.A_threat).expandDims(0);
      const globalBatch = tf.tensor2d([globalFeatures]);
      const result = this.model.forwardBatch(x, a_dist, a_threat, globalBatch);
      const logitsData = Array.from(result.logits.dataSync());
      const valueData = Array.from(result.value.dataSync());
      return { logits: logitsData, value: valueData };
    });
  },

  // === Главный тик ===
  tick: async function () {
    if (!gameStarted || gameState.gameEnded || gameMode !== "gnn") return;
    if (!this.initialized) await this.init();
    if (!this.initialized) return;
    const now = performance.now();

    // 🔥 РЕАБИЛИТАЦИЯ: Сброс флага отступления, если юнит вылечен (>85% HP)
    if (gameState.units) {
      gameState.units.forEach(u => {
        if (u.owner === "ai" && u.forceRetreat && u.health > u.maxHealth * 0.85) {
          u.isRetreating = false;
          u.forceRetreat = false;
          u.missionLog = null; // Юнит здоров и готов получать новые приказы
        }
      });
    }

    this._wrapReplayPush();

    // 1. Оценка мира
    try {
      await this.checkEnd();
      this.assessThreats();
      this.evaluatePhaseRewards(now);
      this.checkTechStagnation(now);
      this.evaluateStagnation(now);
      this.evaluateMilitaryBalance(now);
      this.evaluateOpponentGap(now);
      this.evaluateArmyActivity(now);
      this.evaluateCombatEfficiency(now);
      this.evaluateTargetSelection(now);
      this.evaluateRecon(now);
      this.evaluateExpansion(now);
      this.evaluateReconDiscovery(now);
      this.evaluateEconomyEfficiency(now);
      this.evaluateResourceControl(now);
      this.evaluateMissions();
      this.checkEconomicParalysis(now);
      this.evaluateArmyPreservation(now);
      this.evaluateStrategicAdaptation(now);
      this.evaluateBuildingLiquidation(now);
    } catch (e) {
      console.error("[GnnAI] Error in evaluation phase:", e);
    }

    // 2. Очереди
    if (!this.lastTick.buildQ || now - this.lastTick.buildQ >= CFG.BUILD_QUEUE_MS) {
      this.lastTick.buildQ = now;
      if (typeof processBuildQueue === "function") {
        try { processBuildQueue(); } catch (e) { console.warn("[GnnAI] buildQ error", e); }
      }
    }
    if (CFG.AUTO_ECONOMY && (!this.lastTick.eco || now - this.lastTick.eco >= CFG.ECO_MS)) {
      this.lastTick.eco = now;
      this.autoEconomy();
    }
    this.evaluatePending(now);
    this.benchmarkTick("gnn", this.lastAction);

    // 3. Решение
    if (!this.lastTick.decision || now - this.lastTick.decision >= CFG.DECISION_MS) {
      this.lastTick.decision = now;
      tf.tidy(() => {
        try { this.decide(); } catch(e) { console.error("[GnnAI] Decide error", e); }
      });
    }

    // 4. Обучение (разнесённое по кадрам)
    if (!this.lastTick.train || now - this.lastTick.train >= CFG.TRAIN_MS) {
      this.lastTick.train = now;
      this._trainStepsPending = 4;
      this._doTrainStep();
    }
  },

  // === Оценка угроз (ИСПРАВЛЕНО: учет угрозы для экспансий) ===
  assessThreats: function () {
    const enemyUnits = gameState.units.filter(u => u.owner === "player" && u.health > 0);
    const enemyBuildings = gameState.buildings.filter(b => b.owner === "player" && b.health > 0);
    const composition = {};
    enemyUnits.forEach(u => { composition[u.type] = (composition[u.type] || 0) + 1; });
    
    let threatLevel = 0;
    enemyUnits.forEach(u => { threatLevel += this._THREAT_ASSESSMENT[u.type] || 1; });
    
    // Угроза главной базе
    enemyBuildings.filter(b => b.type?.startsWith("turret")).forEach(t => {
      const dist = Math.hypot(t.x - aiBase.x, t.y - aiBase.y);
      if (dist < 600) threatLevel += (this._THREAT_ASSESSMENT[t.type] || 2) * 2;
    });

    // ИСПРАВЛЕНО: Угроза экспансиям (складам и маякам)
    const aiExpansions = gameState.buildings.filter(b => 
      b.owner === "ai" && ["warehouse", "beacon", "barracks", "barracks2", "barracks3"].includes(b.type) && b.health > 0
    );
    
    aiExpansions.forEach(exp => {
      const enemiesNear = enemyUnits.filter(u => Math.hypot(u.x - exp.x, u.y - exp.y) < 400).length;
      const turretsNear = enemyBuildings.filter(b => b.type?.startsWith("turret") && Math.hypot(b.x - exp.x, b.y - exp.y) < 500).length;
      
      if (enemiesNear > 0 || turretsNear > 0) {
        threatLevel += (enemiesNear * 3) + (turretsNear * 5); // Повышаем общий уровень угрозы, если экспанция под давлением
      }
    });

    this.strategicMemory.enemyComposition = composition;
    this.strategicMemory.threatLevel = threatLevel;
  }
});