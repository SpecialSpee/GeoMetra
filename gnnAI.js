// ============================================================
// gnnAI.js — Истинно самообучающийся Графовый ИИ v6.7 (Smooth & Normalized).
// ============================================================

(function () {
  "use strict";

  if (window.GnnAI) {
    console.warn("[GnnAI] уже загружен");
    return;
  }

  const CFG = {
    MAX_NODES: 64,
    NODE_FEATURES: 36,
    GLOBAL_FEATURES: 22,
    HIDDEN: 128,
    LR: 0.001,
    DECISION_MS: 500,
    MIN_COMMIT_MS: 30000, // 🔥 ГИСТЕРЕЗИС: Минимальное время приверженности стратегии (8 сек)
    WORLD_WIDTH: 2000,   // 🔥 ДЛЯ НОРМИРОВКИ: Ширина карты
    WORLD_HEIGHT: 2000,  // 🔥 ДЛЯ НОРМИРОВКИ: Высота карты
    BUILD_QUEUE_MS: 500,
    ECO_MS: 1500,
    TRAIN_MS: 2000,
    SAVE_EVERY_BATCHES: 10,
    INTERACTION_RADIUS: 320,
    BASE_THREAT_RADIUS: 450,
    REPLAY_SIZE: 2000,
    BATCH_SIZE: 64,
    AUTO_ECONOMY: false, 
    STORAGE_KEY: "geomestra_gnn_weights_v6",
    STATS_KEY: "geomestra_gnn_benchmark_v6"
  };

  class RingBuffer {
    constructor(capacity) {
      this.capacity = capacity;
      this.buffer = new Array(capacity);
      this.head = 0;
      this.size = 0;
    }
    push(item) {
      this.buffer[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      if (this.size < this.capacity) this.size++;
    }
    get length() { return this.size; }
    getRandom() {
      if (this.size === 0) return null;
      const idx = Math.floor(Math.random() * this.size);
      return this.buffer[(this.head - this.size + idx + this.capacity) % this.capacity];
    }
  }

  const WeightDB = {
    db: null,
    async init() {
      if (this.db) return;
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('GnnAI_Weights_DB', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('models');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async save(key, data) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('models', 'readwrite');
        tx.objectStore('models').put(data, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    async load(key) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('models', 'readonly');
        const req = tx.objectStore('models').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
  };

  const G_ACTIONS = [
    "defend", 
    "build_warehouse", "build_repair", "build_barracks", "build_turret1", 
    "build_beacon", "build_base2", "build_barracks2", "build_turret2", 
    "build_base3", "build_barracks3", "build_turret3",
    "hireWorker", "hireRepairman", "hireFighter", "hireAssault", "hireElite", 
    
    "tactic_all_in",    
    "tactic_harass",    
    "tactic_push",      
    "tactic_defend",    
    
    "idle"
  ];
  const AIDX = Object.fromEntries(G_ACTIONS.map((a, i) => [a, i]));

  const THREAT_ASSESSMENT = {
    turret: 3, turret2: 5, turret3: 7,
    fighter: 2, assault: 4, elite: 6
  };

  const GnnAI = {
    cfg: CFG,
    actions: G_ACTIONS,
    model: null,
    optimizer: null,
    vars: [],
    replay: new RingBuffer(CFG.REPLAY_SIZE),
    pending: [],
    initialized: false,
    training: false,
    trainBatches: 0,
    lastTick: {},
    lastState: null,
    lastAction: null,
    episode: null,
    episodeReport: null,
    lastPhaseCheck: 0,
	  
    strategicMemory: {
      enemyComposition: {},
      threatLevel: 0, 
      lastTechLevel: 1,
      techProgressionTime: 0
    },
    
    missionCache: [], 
    lastStagnationCheck: 0,
    lastBuildingBuilt: {},
    lastArmySize: 0,
    lastBuildingCount: 0,
    
    lastStrategicChangeTime: 0, // 🔥 Для гистерезиса
    lastStrategicAction: null,  // 🔥 Для гистерезиса

	getGlobalFeatures: function () {
      if (!window.gameState || !window.aiBase) return new Array(CFG.GLOBAL_FEATURES).fill(0);
      const m = this.metrics();
      
      const threat = Math.min(1, this.strategicMemory.threatLevel / 30);
      const baseHp = m.baseHp;
      const enemyNear = Math.min(1, m.enemyNear / 10);
      const myArmy = Math.min(1, m.aiArmy / 20);
      const enemyArmy = Math.min(1, m.enemyArmy / 20);
      const armyBalance = Math.min(1, m.aiArmy / (m.enemyArmy + 1));
      
      let tech = 1;
      if (gameState.buildings.some(b => b.owner === "ai" && ["base2", "barracks2", "turret2"].includes(b.type))) tech = 2;
      if (gameState.buildings.some(b => b.owner === "ai" && ["base3", "barracks3", "turret3"].includes(b.type))) tech = 3;
      const techLevel = tech / 3;

      const resTotal = Math.min(1, (m.res.gold + m.res.silicon + m.res.plasma) / 1000);
      const warehouseCount = Math.min(1, m.aiWarehouses / 10);
      const turretCount = Math.min(1, m.aiTurrets / 10);
      const timeNorm = Math.min(1, performance.now() / 600000);
      
      const enemyTurrets = Math.min(1, gameState.buildings.filter(b => b.owner === "player" && b.type?.startsWith("turret")).length / 10);
      const enemyElites = Math.min(1, (this.strategicMemory.enemyComposition.elite || 0) / 5);
      
      const buildingDiversity = Math.min(1, m.aiBuildings / 15);
      const resourceEfficiency = m.resTotal > 0 ? Math.min(1, m.aiArmy / (m.resTotal / 100)) : 0;
      const expansionProgress = Math.min(1, m.aiWarehouses / 5);
      const defenseStrength = Math.min(1, m.aiTurrets / 5);
      const gameTimeMinutes = performance.now() / 60000;
      const techStagnationPenalty = gameTimeMinutes > 3 && tech < 2 ? 1 : 0;

      const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks") ? 1 : 0;
      const hasBeacon = gameState.buildings.some(b => b.owner === "ai" && b.type === "beacon") ? 1 : 0;
      const canBuildBarracks2 = (hasBarracks && hasBeacon) ? 1 : 0; 

      let totalEnemyDps = 0;
      let totalMyDps = 0;
      gameState.units.forEach(u => {
        const dps = this.getUnitDps(u.type) || 0;
        if (u.owner === "player" && u.health > 0) totalEnemyDps += dps;
        if (u.owner === "ai" && u.health > 0) totalMyDps += dps;
      });
      
      const normalizedEnemyDps = Math.min(1, totalEnemyDps / 500);
      const normalizedMyDps = Math.min(1, totalMyDps / 500);

      const enemyWorkers = gameState.units.filter(u => u.owner === "player" && u.type === "worker" && u.health > 0).length;
      const myWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
      
      const economyGap = Math.max(-1, Math.min(1, (myWorkers - enemyWorkers) / 8)); 
      
      const enemyArmyValue = gameState.units.filter(u => u.owner === "player" && u.health > 0).reduce((sum, u) => sum + this.getUnitValue(u.type), 0);
      const myArmyValue = gameState.units.filter(u => u.owner === "ai" && u.health > 0).reduce((sum, u) => sum + this.getUnitValue(u.type), 0);
      const armyGap = Math.max(-1, Math.min(1, (myArmyValue - enemyArmyValue) / 600));

      let enemyTech = 1;
      if (gameState.buildings.some(b => b.owner === "player" && ["base2", "barracks2", "turret2"].includes(b.type))) enemyTech = 2;
      if (gameState.buildings.some(b => b.owner === "player" && ["base3", "barracks3", "turret3"].includes(b.type))) enemyTech = 3;
      const techGap = (tech - enemyTech) / 2; 

      return [
        threat, baseHp, enemyNear, myArmy, enemyArmy, armyBalance, techLevel, 
        resTotal, warehouseCount, turretCount, timeNorm, enemyTurrets, enemyElites,
        buildingDiversity, resourceEfficiency, expansionProgress, defenseStrength,
        gameTimeMinutes, techStagnationPenalty,
        economyGap,   
        armyGap,      
        techGap       
      ];
    },

    registerAction: function (action, graphState, intent, actionIndex) {
      if (!graphState || !graphState.X || !graphState.A_distance) return;
      
      let currentValue = 0;
      let currentLogProb = 0;
      const actionMask = this.validActionMask();
      
      if (this.model) {
        tf.tidy(() => {
          const pred = this.predict(graphState);
          currentValue = pred.value.dataSync()[0];
          const logits = pred.logits.dataSync();
          const maskedLogits = logits.map((v, i) => actionMask[i] === 1 ? v : -1e9);
          const maxLogit = Math.max(...maskedLogits);
          const expLogits = maskedLogits.map(v => Math.exp(v - maxLogit));
          const sumExp = expLogits.reduce((a, b) => a + b, 0) || 1;
          const probs = expLogits.map(v => v / sumExp);
          currentLogProb = Math.log(probs[actionIndex] || 1e-10);
        });
      }

      const replayEntry = {
        X: graphState.X, 
        A_distance: graphState.A_distance, 
        A_threat: graphState.A_threat,     
        actionIndex: actionIndex !== undefined ? actionIndex : -1,
        actionMask: actionMask,       
        oldLogProb: currentLogProb,   
        value: currentValue,          
        reward: 0
      };
      this.replay.push(replayEntry);
      
      const m = this.metrics();
      const snapshot = {
        threatLevel: this.strategicMemory.threatLevel,
        aiArmy: m.aiArmy,
        resTotal: m.resTotal,
        ecoEfficiency: m.ecoEfficiency,
        techLevel: m.techLevel,
        aiBuildings: m.aiBuildings,
        aiWarehouses: m.aiWarehouses,
        aiTurrets: m.aiTurrets,
        time: performance.now()
      };

      if (this.episodeReport) {
        this.episodeReport.actions[action] = (this.episodeReport.actions[action] || 0) + 1;
        this.episodeReport.timeline.push({
          time: (performance.now() / 1000).toFixed(1) + ' сек',
          action: action,
          detail: intent && intent.type === "build" ? intent.buildingType : (intent && intent.type === "hire" ? intent.unitType : intent.type),
          resources: m.resTotal,
          army: m.aiArmy,
          tech: m.techLevel
        });
      }

      if (intent && intent.unitIds && intent.unitIds.length > 0) {
        snapshot.unitStartHP = intent.unitIds.reduce((sum, id) => {
          const u = gameState.units.find(x => x.id === id);
          return sum + (u ? u.health : 0);
        }, 0);
        
        if (intent.targetId) {
          const target = gameState.units.find(u => u.id === intent.targetId) || gameState.buildings.find(b => b.id === intent.targetId);
          snapshot.targetStartHP = target ? target.health : 0;
          snapshot.targetId = intent.targetId;
        }
        if (intent.anchor) {
          snapshot.anchorId = intent.anchor;
        }
      }

      if (intent && intent.type === "defend") {
          let anchor = null;
          if (intent.anchor === "aiBase") {
              anchor = window.aiBase;
          } else {
              anchor = gameState.buildings.find(b => b.id === intent.anchor);
          }
          
          if (anchor) {
              snapshot.enemiesNearAnchorAtStart = gameState.units.filter(u => 
                  u.owner === "player" && u.health > 0 && Math.hypot(u.x - anchor.x, u.y - anchor.y) < 300
              ).length;
          } else {
              snapshot.enemiesNearAnchorAtStart = 0;
          }
      }

      this.missionCache.push({
        action: action,
        intent: intent,
        snapshot: snapshot,
        resolved: false,
        replayEntry: replayEntry
      });

      if (this.episodeAchievements && intent) {
          let achievementBonus = 0;

          if (intent.type === "build") {
              if (intent.buildingType === "barracks" && !this.episodeAchievements.firstBarracks) {
                  this.episodeAchievements.firstBarracks = true;
                  achievementBonus = 15.0;
              } else if (intent.buildingType === "base2" && !this.episodeAchievements.firstBase2) {
                  this.episodeAchievements.firstBase2 = true;
                  achievementBonus = 50.0; 
              } else if (intent.buildingType === "barracks2" && !this.episodeAchievements.firstBarracks2) {
                  this.episodeAchievements.firstBarracks2 = true;
                  achievementBonus = 40.0;
              } else if (intent.buildingType === "base3" && !this.episodeAchievements.firstBase3) {
                  this.episodeAchievements.firstBase3 = true;
                  achievementBonus = 100.0; 
              } else if (intent.buildingType === "barracks3" && !this.episodeAchievements.firstBarracks3) {
                  this.episodeAchievements.firstBarracks3 = true;
                  achievementBonus = 80.0;
              }
          
          } else if (intent.type === "hire") {
              if (intent.unitType === "worker") {
                  const currentWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
                  if (currentWorkers === 0) { 
                      replayEntry.reward += 25.0;
                  } else {
                      replayEntry.reward += 5.0;
                  }
              }

              if (intent.unitType === "assault" && !this.episodeAchievements.firstAssault) {
                  this.episodeAchievements.firstAssault = true;
                  achievementBonus = 20.0;
              } else if (intent.unitType === "elite" && !this.episodeAchievements.firstElite) {
                  this.episodeAchievements.firstElite = true;
                  achievementBonus = 30.0;
              }
          }

          if (achievementBonus > 0) {
              replayEntry.reward += achievementBonus;
          }
      }

      if (intent && intent.type === "hire" && ["fighter", "assault", "elite"].includes(intent.unitType)) {
          const workers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
          const warehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
          const gameTimeMin = performance.now() / 60000;

          if (gameTimeMin > 0.5 && (workers < 2 || warehouses === 0)) {
              const penalty = -5.0; 
              replayEntry.reward += penalty;
              console.warn(`[GnnAI] 🚫 НАЛОГ НА АРМИЮ: Попытка нанять ${intent.unitType} без экономики! Штраф: ${penalty}`);
          }
      }
    },
	  
    checkEconomicParalysis: function(now) {
      if (!this.lastEcoCheck || now - this.lastEcoCheck < 10000) return;
      this.lastEcoCheck = now;
      
      const m = this.metrics();
      const gameTimeMin = performance.now() / 60000;
      
      const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
      const economyBuildings = gameState.buildings.filter(b => b.owner === "ai" && (b.type === "warehouse" || b.type === "repairWorkshop") && b.active).length;
      
      if (economyBuildings > 0 && workerCount === 0 && gameTimeMin > 0.5) {
          const currentState = this.buildGraphState();
          if (currentState) {
              this.replay.push({ 
                  X: currentState.X, 
                  A_distance: currentState.A_distance, 
                  A_threat: currentState.A_threat, 
                  actionIndex: AIDX.idle, 
                  reward: -5.0 
              });
          }
      }
    },

    getUnitValue: function(type) {
      const values = { worker: 10, repairman: 15, fighter: 30, assault: 60, elite: 120, turret: 40, turret2: 60, turret3: 80, base: 500, base2: 600, base3: 800, barracks: 50, warehouse: 30, repairWorkshop: 30, beacon: 40 };
      return values[type] || 20;
    },

    evaluateMissions: function () {
      for (let i = this.missionCache.length - 1; i >= 0; i--) {
        const mission = this.missionCache[i];
        if (mission.resolved) {
          this.missionCache.splice(i, 1);
          continue;
        }

        let rewardDelta = 0;
        let isResolved = false;
        let reason = "";
        const m = this.metrics();   

        if (mission.intent.type === "attack") {
          const aliveAttackers = (mission.intent.unitIds || []).reduce((sum, id) => {
            const u = gameState.units.find(x => x.id === id);
            return sum + (u && u.health > 0 ? 1 : 0);
          }, 0);
          const lostAttackers = mission.intent.unitIds.length - aliveAttackers;
          
          const target = gameState.units.find(u => u.id === mission.snapshot.targetId) || gameState.buildings.find(b => b.id === mission.snapshot.targetId);
          const currentTargetHP = target ? target.health : 0;
          const damageDealt = Math.max(0, mission.snapshot.targetStartHP - currentTargetHP);

          const tactic = mission.intent.tactic || "tactic_push"; 
          let tacticReward = 0;
          let reason = "";

          if (target && currentTargetHP <= 0) {
            if (tactic === "tactic_harass" && (target.type === "worker" || target.type === "warehouse" || target.type === "repairWorkshop")) {
              tacticReward = 25.0; 
              reason = "HARASS_SUCCESS: Экономика врага успешно уничтожена";
            } else if (tactic === "tactic_all_in" && (target.type === "base" || target.type === "base2" || target.type === "base3")) {
              tacticReward = 100.0;
              reason = "ALL_IN_SUCCESS: Вражеская база уничтожена";
            } else {
              tacticReward = 10.0;
              reason = "TARGET_DESTROYED: Обычная цель уничтожена";
            }
            isResolved = true;
          } 
          else if (tactic === "tactic_defend") {
             const enemiesNearBaseNow = gameState.units.filter(u => 
               u.owner === "player" && u.health > 0 && 
               Math.hypot(u.x - aiBase.x, u.y - aiBase.y) < 400
             ).length;
             
             const enemiesAtStart = mission.snapshot.enemiesNearAnchorAtStart || 0;
             
             if (enemiesAtStart > 0 || enemiesNearBaseNow > 0) {
               if (lostAttackers < (mission.intent.unitIds.length * 0.3)) {
                 tacticReward = 15.0;
                 reason = "DEFENSE_SUCCESS: Реальная атака отбита с минимальными потерями";
                 isResolved = true;
               } else if (lostAttackers > 0 && damageDealt < (lostAttackers * 10)) {
                 tacticReward = -15.0;
                 reason = "DEFENSE_FAILURE: Потеряли слишком много юнитов при обороне";
                 isResolved = true;
               }
             } else {
               tacticReward = -5.0;
               reason = "FALSE_DEFENSE: Выбрана оборона, но врагов рядом не было";
               isResolved = true;
             }
          }
          else if (lostAttackers > 0 && damageDealt < (lostAttackers * 10)) {
             tacticReward = -15.0;
             reason = "TACTIC_FAILURE: Бесполезные потери без урона";
             isResolved = true;
          }
          else if (!target && aliveAttackers === 0) {
             tacticReward = -15.0;
             reason = "USELESS_SACRIFICE: Отряд погиб, не найдя цели";
             isResolved = true;
          }
          else if (damageDealt > 0 && (performance.now() - mission.snapshot.time) > 5000) {
             tacticReward = Math.min(5.0, damageDealt / 20);
             reason = "DAMAGE_PROGRESS: Наносим урон цели";
          }

          rewardDelta += tacticReward;
        }
		  
        else if (mission.intent.type === "defend") {
          const anchor = (mission.snapshot.anchorId === "aiBase") ? window.aiBase : gameState.buildings.find(b => b.id === mission.snapshot.anchorId);
          let enemiesNearAnchorNow = 0;
          if (anchor) {
            enemiesNearAnchorNow = gameState.units.filter(u => u.owner === "player" && u.health > 0 && Math.hypot(u.x - anchor.x, u.y - anchor.y) < 300).length;
          }
          const enemiesAtStart = mission.snapshot.enemiesNearAnchorAtStart || 0;
          const aliveDefenders = (mission.intent.unitIds || []).reduce((sum, id) => {
            const u = gameState.units.find(x => x.id === id);
            return sum + (u && u.health > 0 ? 1 : 0);
          }, 0);
          const totalDefendersAtStart = mission.intent.unitIds ? mission.intent.unitIds.length : 0;

          if (enemiesAtStart > 0 && enemiesNearAnchorNow === 0 && aliveDefenders > 0) {
            rewardDelta = 6.0; reason = "successful_defense_OUTCOME"; isResolved = true;
          } else if (enemiesAtStart === 0 && enemiesNearAnchorNow === 0) {
            rewardDelta = -3.0; reason = "defending_nothing_penalty"; isResolved = true;
          } else if (totalDefendersAtStart > 0 && aliveDefenders === 0) {
            rewardDelta = -6.0; reason = "all_defenders_lost_OUTCOME"; isResolved = true;
          } else if (enemiesNearAnchorNow > 0 && aliveDefenders > 0) {
            rewardDelta = 0.5; 
          }
        }
        else if (mission.intent.type === "hire") {
          if (this.metrics().aiArmy > mission.snapshot.aiArmy || mission.intent.unitType === "worker" || mission.intent.unitType === "repairman") {
            const type = mission.intent.unitType;
            let hireReward = 0;
            if (type === "fighter" && this.strategicMemory.threatLevel >= 5) { hireReward = 2.0; reason = "heroic_recruitment_under_high_threat"; } 
            else if (type === "fighter") { hireReward = 1.0; reason = "fighter_hired"; } 
            else if (type === "worker") { hireReward = 1.5; } 
            else if (type === "repairman") { hireReward = 1.0; } 
            else if (type === "assault") { hireReward = 3.0; } 
            else if (type === "elite") { hireReward = 5.0; }
            rewardDelta = hireReward;
            reason = reason || `unit_hired_${type}_reward`;
            isResolved = true;
          } else {
            const elapsed = performance.now() - mission.snapshot.time;
            if (elapsed > 10000) { rewardDelta = -1.0; reason = "hire_failed_or_timeout_penalty"; isResolved = true; }
          }
        }
        else if (mission.intent.type === "build") {
          const isBuilt = gameState.buildings.some(b => b.owner === "ai" && b.type === mission.intent.buildingType && b.active);
          if (isBuilt) {
            const prev = mission.snapshot;
            let reasonBuild = "";
            if (!["warehouse", "repairWorkshop"].includes(mission.intent.buildingType)) { rewardDelta += 5.0; reasonBuild = "building_constructed_bonus"; }
            else {
              if (m.aiArmy > prev.aiArmy || m.resTotal < prev.resTotal) { rewardDelta = 3.0; reasonBuild = "eco_building_utilized"; } 
              else { rewardDelta = -1.0; reasonBuild = "eco_building_stagnation"; }
            }
            rewardDelta = Math.round(rewardDelta * 10) / 10;
            reason = `build_consequence_${reasonBuild}`;
            isResolved = true;
          } else {
            const elapsed = performance.now() - mission.snapshot.time;
            if (elapsed > 30000) { rewardDelta = -5.0; reason = "build_timeout_or_cancelled"; isResolved = true; }
          }
        }
        else if (mission.intent.type === "idle") {
          const m = this.metrics();
          if (m.resTotal > 200) { rewardDelta = -1.0; reason = "idle_with_resources_penalty"; } 
          else { rewardDelta = -0.2; reason = "waiting"; }
          isResolved = true;
        }

        if (isResolved || rewardDelta !== 0) {
            const clippedDelta = Math.max(-15.0, Math.min(15.0, rewardDelta));
            mission.replayEntry.reward += clippedDelta;
            if (Math.abs(clippedDelta) > 1.0 || reason.includes("OUTCOME") || reason.includes("penalty")) {
                console.log(`[GnnAI Cache] 🎯 '${mission.action}' → ${clippedDelta >= 0 ? '+' : ''}${clippedDelta.toFixed(2)} (${reason})`);
            }
            if (isResolved) mission.resolved = true;
        }
      }
    },

    evaluateStagnation: function (now) {
      if (now - this.lastStagnationCheck < 5000) return;
      this.lastStagnationCheck = now;

      const m = this.metrics();
      const gameTimeMin = performance.now() / 60000;
      let penalty = 0;
      let reasons = [];

      const workers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
      
      if (gameTimeMin > 2.5 && m.aiWarehouses < 2) {
        penalty -= 30.0; 
        reasons.push("SEVERE_STAGNATION: ONLY_1_WAREHOUSE_LATE_GAME");
      }
      
      if (gameTimeMin > 3.0 && workers < 4) {
        penalty -= 25.0; 
        reasons.push("SEVERE_STAGNATION: LESS_THAN_4_WORKERS_LATE_GAME");
      }

      const repairmen = gameState.units.filter(u => u.owner === "ai" && u.type === "repairman" && u.health > 0).length;
      if (repairmen > 0 && m.baseHp > 0.8 && m.enemyNear > 0) {
        penalty += 3.0; 
        reasons.push("successful_repair_maintenance");
      }

      if (m.resTotal > 300 && m.aiArmy === this.lastArmySize && m.aiBuildings === this.lastBuildingCount) {
        penalty -= 2.0; reasons.push("resource_hoarding_without_investment");
      }
      if (m.aiTurrets >= 4 && m.aiArmy < 3 && gameTimeMin > 4) {
        penalty -= 3.0; reasons.push("turtle_strategy_without_army");
      }
      if (gameTimeMin > 5 && m.techLevel === 1) {
        penalty -= 5; reasons.push("tech_stagnation_tier1");
      }
      if (m.aiArmy > this.lastArmySize && m.resTotal < 150) {
        penalty += 2.0; reasons.push("healthy_economy_to_military_conversion");
      }
      if (m.resTotal > 2000 && m.aiArmy < 10) {
        penalty -= 5.0; reasons.push("hoarding_resources_without_army");
      }

      if (penalty !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward: penalty });
          if (penalty < 0) console.warn(`[GnnAI] ⚠️ Обнаружен тупик: ${penalty} (${reasons.join(', ')})`);
        }
      }
		
      const beaconsCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.health > 0).length;
      if (beaconsCount >= 2 && m.aiArmy < 3 && m.enemyNear > 0) {
        penalty -= 15.0;
        reasons.push("FOOLISH_EXPANSION: Построен маяк, но нечем его защитить от врага!");
      }

      this.lastArmySize = m.aiArmy;
      this.lastBuildingCount = m.aiBuildings;
      this.lastResourceTotal = m.resTotal;
    },
	  
    evaluateMilitaryBalance: function (now) {
      if (!this.lastMilitaryCheck || now - this.lastMilitaryCheck < 3000) return;
      this.lastMilitaryCheck = now;

      const m = this.metrics();
      let penalty = 0;
      let reasons = [];

      const myUnits = gameState.units.filter(u => u.owner === "ai" && u.health > 0);
      const enemyUnits = gameState.units.filter(u => u.owner === "player" && u.health > 0);

      let myPower = 0;
      myUnits.forEach(u => { myPower += u.health + (this.getUnitDps(u.type) * 10); });

      let enemyPower = 0;
      enemyUnits.forEach(u => { enemyPower += u.health + (this.getUnitDps(u.type) * 10); });

      const turretCount = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0).length;
      const myDefensePower = turretCount * 150; 

      const totalMyStrength = myPower + myDefensePower;

      if (enemyPower > 0) {
        if (totalMyStrength < enemyPower * 0.5) {
          penalty -= 10.0;
          reasons.push("CRITICAL_WEAK_DEFENSE: Враг в 2 раза сильнее!");
        } else if (totalMyStrength > enemyPower * 1.5) {
          penalty += 5.0;
          reasons.push("STRONG_DEFENSE: Превосходство в силе!");
        }
      }

      if (m.enemyNear > 0 && m.baseHp > 0.95 && turretCount > 0) {
        penalty += 3.0;
        reasons.push("EFFECTIVE_DEFENSE: База цела под огнем!");
      }

      if (penalty !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward: penalty });
          if (penalty < 0) console.warn(`[GnnAI] ⚠️ Дисбаланс сил: ${penalty} (${reasons.join(', ')})`);
        }
      }
    },

    evaluateOpponentGap: function (now) {
      if (!this.lastGapCheck || now - this.lastGapCheck < 3000) return;
      this.lastGapCheck = now;

      const m = this.metrics();
      const gameTimeMin = performance.now() / 60000;
      let penalty = 0;
      let reasons = [];

      const enemyWorkers = gameState.units.filter(u => u.owner === "player" && u.type === "worker" && u.health > 0).length;
      const myWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
      
      if (gameTimeMin > 1.5 && myWorkers < enemyWorkers - 2) {
        penalty -= 15.0;
        reasons.push(`ECONOMIC_LAG: У врага ${enemyWorkers} рабочих, у нас ${myWorkers}. Срочно строить склады!`);
      }

      const enemyArmyValue = gameState.units.filter(u => u.owner === "player" && u.health > 0).reduce((sum, u) => sum + this.getUnitValue(u.type), 0);
      const myArmyValue = m.aiArmy * 30; 

      if (gameTimeMin > 2.0 && enemyArmyValue > myArmyValue + 150) {
        penalty -= 20.0;
        reasons.push("MILITARY_LAG: Враг превосходит в силе! Нужна срочная мобилизация или турели!");
      }

      const enemyHasBase2 = gameState.buildings.some(b => b.owner === "player" && b.type === "base2");
      const myHasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2");
      
      if (gameTimeMin > 4.0 && enemyHasBase2 && !myHasBase2) {
        penalty -= 25.0;
        reasons.push("TECH_LAG: Враг перешел на Тир-2, а мы застряли! Нужно расширяться!");
      }

      if (penalty < 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ 
            X: currentState.X, 
            A_distance: currentState.A_distance, 
            A_threat: currentState.A_threat, 
            actionIndex: AIDX.idle, 
            reward: penalty 
          });
          console.warn(`[GnnAI] ⚠️ Отставание от противника: ${penalty} (${reasons.join(', ')})`);
        }
      }
    },
 
    evaluatePhaseRewards: function (now) {
      if (!this.lastPhaseCheck || now - this.lastPhaseCheck < 5000) return;
      this.lastPhaseCheck = now;

      const m = this.metrics();
      const gameTimeMin = performance.now() / 60000;
      let phaseReward = 0;
      let reasons = [];

      const workers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
      const barracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks");
      const armySize = m.aiArmy;

      if (gameTimeMin < 2.0) {
        const wCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
        const barr = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);

        if (wCount >= 4) { phaseReward += 20.0; reasons.push("PHASE1_EXCELLENT_ECONOMY_4+_WORKERS"); } 
        else if (wCount >= 2) { phaseReward += 10.0; reasons.push("PHASE1_GOOD_ECONOMY_2+_WORKERS"); } 
        else if (wCount >= 1) { phaseReward += 3.0; reasons.push("PHASE1_BASIC_ECONOMY"); }

        if (gameTimeMin > 1.0 && wCount < 2) { phaseReward -= 30.0; reasons.push("PHASE1_CRITICAL_ECONOMIC_STAGNATION"); }
        if (gameTimeMin > 1.5 && m.aiWarehouses < 2) { phaseReward -= 20.0; reasons.push("PHASE1_LACK_OF_INFRASTRUCTURE"); }
        if (barr && wCount < 3) { phaseReward -= 30.0; reasons.push("PHASE1_PREMATURE_MILITARY_SUICIDE"); }
      }
      else if (gameTimeMin < 4.0) {
        const wCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
        const barr = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);

        if (barr && wCount >= 4) { phaseReward += 20.0; reasons.push("PHASE2_PERFECT_MACRO_BALANCE"); }
        if (m.resTotal > 100 && m.aiWarehouses < 2) { phaseReward -= 25.0; reasons.push("PHASE2_HOARDING_WITHOUT_EXPANSION"); }
        if (armySize > 0 && wCount < 3) { phaseReward -= 15.0; reasons.push("PHASE2_ATTACKING_WITH_WEAK_ECONOMY"); }
        if (armySize === 0 && gameTimeMin > 3.0) { phaseReward -= 15.0; reasons.push("PHASE2_ZERO_ARMY_PENALTY"); }
      }
      else if (gameTimeMin < 6.0) {
        const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2");
        if (hasBase2) { phaseReward += 12.0; reasons.push("PHASE3_TIER2_ACHIEVEMENT_BONUS"); }
        if (!hasBase2) {
          const minutesLate = gameTimeMin - 3.0;
          phaseReward -= (5.0 * minutesLate); 
          reasons.push(`PHASE3_TIER1_STAGNATION_PENALTY (-${(5.0 * minutesLate).toFixed(1)})`);
        }
      }
      else {
        const eliteCount = gameState.units.filter(u => u.owner === "ai" && u.type === "elite").length;
        const assaultCount = gameState.units.filter(u => u.owner === "ai" && u.type === "assault").length;
        
        if (assaultCount > 0 || eliteCount > 0) { phaseReward += 10.0; reasons.push("PHASE4_ADVANCED_UNITS_BONUS"); }
        if (armySize > 10) {
          const fighterCount = gameState.units.filter(u => u.owner === "ai" && u.type === "fighter").length;
          if (fighterCount / armySize > 0.9) { phaseReward -= 8.0; reasons.push("PHASE4_INEFFICIENT_ARMY_COMPOSITION_PENALTY"); }
        }
      }

      if (phaseReward !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward: phaseReward });
          if (phaseReward > 0) {
            console.log(`[GnnAI Phase] 💰 Фазовая награда: +${phaseReward.toFixed(1)} (${reasons.join(', ')})`);
          } else {
            console.warn(`[GnnAI Phase] ⚠️ Фазовый штраф: ${phaseReward.toFixed(1)} (${reasons.join(', ')})`);
          }
        }
      }
    },
	  
    checkTechStagnation: function (now) {
      if (now - this.lastStagnationCheck < 10000) return;
      this.lastStagnationCheck = now;

      const m = this.metrics();
      const gameTimeMin = performance.now() / 60000;
      let penalty = 0;
      let reasons = [];
		
      const isUnderThreat = this.strategicMemory.threatLevel > 0;
      const hasNoArmy = m.aiArmy === 0;

      if (isUnderThreat && hasNoArmy && gameTimeMin > 1.0) {
          penalty -= 15.0;
          reasons.push("PANIC: ZERO ARMY UNDER THREAT!");
      }	
		
      if (m.aiTurrets >= 3 && m.aiArmy === 0 && gameTimeMin > 3) {
        penalty -= 10.0;
        reasons.push("CRITICAL: turrets_but_no_army_PACIFIST_TRAP");
      }

      const hasEconomyBuildings = gameState.buildings.some(b => b.owner === "ai" && (b.type === "warehouse" || b.type === "repairWorkshop") && b.active);
      const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;

      if (hasEconomyBuildings && workerCount === 0 && gameTimeMin > 0.5) {
          penalty -= 20.0;
          reasons.push("CRITICAL: buildings_without_workers_ECONOMIC_SUICIDE");
      }

      if (workerCount === 0 && gameTimeMin > 1) {
          const minutesWithoutWorkers = gameTimeMin - 1;
          penalty -= 10.0 * minutesWithoutWorkers;
          reasons.push(`CRITICAL: no_workers_${minutesWithoutWorkers.toFixed(1)}min`);
      }

      const currentRes = m.resTotal;
      if (this.lastResourceTotal > 0) {
          const resourceGrowth = currentRes - this.lastResourceTotal;
          if (resourceGrowth <= 0 && gameTimeMin > 0.3 && workerCount === 0) {
              penalty -= 15.0;
              reasons.push("CRITICAL: zero_resource_income_no_workers");
          }
      }

      // 🔥 ИСПРАВЛЕНИЕ: Считаем только боевые единицы
      const units = gameState.units.filter(u => u.owner === "ai" && u.health > 0);
      const combatUnits = units.filter(u => ["fighter", "assault", "elite"].includes(u.type));
      const fighterCount = combatUnits.filter(u => u.type === "fighter").length;
      const assaultCount = combatUnits.filter(u => u.type === "assault").length;
      const eliteCount = combatUnits.filter(u => u.type === "elite").length;
      const totalArmy = combatUnits.length;
      
      if (totalArmy > 15 && gameTimeMin > 5) {
          const fighterRatio = fighterCount / totalArmy;
          if (fighterRatio > 0.8) { penalty -= 8.0; reasons.push("inefficient_army_composition_80_percent_fighters"); }
          if (fighterRatio > 0.9) { penalty -= 12.0; reasons.push("terrible_army_composition_90_percent_fighters"); }
      }

      const uniqueTypes = (fighterCount > 0 ? 1 : 0) + (assaultCount > 0 ? 1 : 0) + (eliteCount > 0 ? 1 : 0);
      if (uniqueTypes >= 2 && gameTimeMin > 6) { penalty += 5.0; reasons.push("diverse_army_bonus"); }
      if (uniqueTypes === 3 && gameTimeMin > 8) { penalty += 10.0; reasons.push("full_composition_bonus"); }

      const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
      const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2" && b.active);
      const hasBase3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base3" && b.active);

      // 🔥 ПРОВЕРКА WIP (Work In Progress): Есть ли здания в очереди?
      const base2Wip = (window.buildQueue || []).some(q => q.type === "base2");
      const barracksWip = (window.buildQueue || []).some(q => q.type === "barracks");

      if (gameTimeMin > 4 && !hasBarracks && !barracksWip) { penalty -= 3.0; reasons.push("no_barracks_by_4min_CRITICAL"); }
      if (gameTimeMin > 8 && !hasBase2 && !base2Wip) { penalty -= 8.0; reasons.push("tech_stagnation_tier1_CRITICAL"); }
      if (gameTimeMin > 12 && !hasBase3) { penalty -= 4.0; reasons.push("no_base3_by_12min"); }

      const turretCount = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.active).length;
      if (turretCount > 5 && m.aiArmy < 3 && gameTimeMin > 5) { penalty -= 2.0; reasons.push("turrets_without_army"); }

      // 🔥 ИСПРАВЛЕННЫЙ БЛОК МАЯКОВ
      const beaconCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.active).length;
      if (beaconCount > 2 && !hasBase2 && !base2Wip && gameTimeMin > 3) { 
          const spamPenalty = -5.0 - (beaconCount * 2.0); 
          penalty += spamPenalty; 
          reasons.push(`BEACON_SPAM_PENALTY: Построено ${beaconCount} маяков, но нет Base2! Бесполезная трата ресурсов.`); 
      }

      if (hasBarracks && hasBase2 && m.aiArmy > 5 && gameTimeMin > 5) { penalty += 2.0; reasons.push("balanced_development"); }

      if (!hasBarracks && !barracksWip && gameTimeMin > 3) {
          const minutesLate = gameTimeMin - 3;
          penalty -= 3.0 * minutesLate;
          reasons.push(`no_barracks_${minutesLate.toFixed(1)}min_late`);
      }
      
      if (!hasBase2 && !base2Wip && gameTimeMin > 6) {
          const minutesLate = gameTimeMin - 6;
          penalty -= 5.0 * minutesLate;
          reasons.push(`no_base2_${minutesLate.toFixed(1)}min_late`);
      }

      // 🔥 НОВЫЙ ШТРАФ: Богатый, но технологически отсталый
      const base2Cost = typeof BASE2_COST !== 'undefined' ? (BASE2_COST.gold || 0) + (BASE2_COST.silicon || 0) : 400;
      if (m.resTotal > Math.max(800, base2Cost * 2) && !hasBase2 && !hasBase3 && !base2Wip && gameTimeMin > 3.0) {
          penalty -= 25.0;
          reasons.push("RICH_FOOL_PENALTY: Много ресурсов (>800), но застревание на Тир-1! Срочно строй Base2!");
      }
													 
      if (penalty !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: AIDX.idle, reward: penalty });
          if (penalty > 0) {
            console.log(`[GnnAI] 💰 Награда за прогресс: +${penalty} (${reasons.join(', ')})`);
          } else {
            console.warn(`[GnnAI] ⚠️ Штраф за регресс: ${penalty} (${reasons.join(', ')})`);
          }
        }
      }
      
      // 🔥 ВАЖНО: Обновляем память о ресурсах в конце проверки
      this.lastResourceTotal = currentRes;
    },

    init: async function () {
      if (this.initialized) return;
      if (this._initializing) {
        while (this._initializing) await new Promise(r => setTimeout(r, 50));
        return;
      }
      this._initializing = true;
      
      if (!window.tf) { console.error("[GnnAI] TF.js не найден"); this._initializing = false; return; }
      
      try {
        await tf.setBackend('webgpu').catch(() => tf.setBackend('webgl'));
        await tf.ready();
      } catch (e) {
        console.warn("[GnnAI] Backend fallback", e);
        try { await tf.setBackend('webgl'); await tf.ready(); } catch (e2) {
          console.error("[GnnAI] Нет доступного backend", e2);
          this._initializing = false;
          return;
        }
      }

      const H = CFG.HIDDEN;
      const F = CFG.NODE_FEATURES;
      const G = CFG.GLOBAL_FEATURES;
      const A = G_ACTIONS.length; 
      const v = (shape, scale = 0.08) => tf.variable(tf.randomNormal(shape, 0, scale));

      const W_attn = v([F * 2, 1]);
      const W1 = v([F, H]), b1 = tf.variable(tf.zeros([H]));
      const W2 = v([H, H]), b2 = tf.variable(tf.zeros([H]));
      const Wp = v([H + G, H]), bp = tf.variable(tf.zeros([H]));
      const Wo = v([H, A]), bo = tf.variable(tf.zeros([A])); 
      const Wv = v([H, 1]), bv = tf.variable(tf.zeros([1]));

      this.vars = [W_attn, W1, b1, W2, b2, Wp, bp, Wo, bo, Wv, bv];
      this.optimizer = tf.train.adam(CFG.LR);

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
            
            const logits = tf.add(tf.matMul(hp, Wo), bo);
            const value = tf.add(tf.matMul(hp, Wv), bv);
            
            return { logits, value };
          });
        }
      };

      await this.loadWeights();
      this.initialized = true;
      this._initializing = false;
      console.log(`[GnnAI] ✅ Модель v6.7 (Smooth & Normalized) готова. Backend: ${tf.getBackend()}`);
    },

    predict: function (state) {
      if (!this.model) {
        return { logits: tf.tensor2d([new Array(G_ACTIONS.length).fill(0)]), value: tf.tensor2d([[0]]) };
      }
      const globalFeatures = this.getGlobalFeatures();
      
      return tf.tidy(() => {
        const x = tf.tensor2d(state.X).expandDims(0);
        const a_dist = tf.tensor2d(state.A_distance).expandDims(0);  
        const a_threat = tf.tensor2d(state.A_threat).expandDims(0);  
        const globalBatch = tf.tensor2d([globalFeatures]); 
        
        return this.model.forwardBatch(x, a_dist, a_threat, globalBatch);
      });
    },

    tick: async function () {
      if (!gameStarted || gameState.gameEnded || gameMode !== "gnn") return;
      if (!this.initialized) await this.init();

      const now = performance.now();
      await this.checkEnd();
      this.assessThreats();
      
      this.evaluatePhaseRewards(now); 
      this.checkTechStagnation(now);
      this.evaluateStagnation(now);
      this.evaluateMilitaryBalance(now);
      this.evaluateOpponentGap(now);
      this.evaluateMissions();
      this.checkEconomicParalysis(now);

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

      if (!this.lastTick.decision || now - this.lastTick.decision >= CFG.DECISION_MS) {
        this.lastTick.decision = now;
        this.decide();
      }

      if (!this.lastTick.train || now - this.lastTick.train >= CFG.TRAIN_MS) {
        this.lastTick.train = now;
        this.trainBatch();
      }
    },

    assessThreats: function () {
      const enemyUnits = gameState.units.filter(u => u.owner === "player" && u.health > 0);
      const enemyBuildings = gameState.buildings.filter(b => b.owner === "player" && b.health > 0);

      const composition = {};
      enemyUnits.forEach(u => { composition[u.type] = (composition[u.type] || 0) + 1; });

      let threatLevel = 0;
      enemyUnits.forEach(u => { threatLevel += THREAT_ASSESSMENT[u.type] || 1; });

      enemyBuildings.filter(b => b.type?.startsWith("turret")).forEach(t => {
        const dist = Math.hypot(t.x - aiBase.x, t.y - aiBase.y);
        if (dist < 600) threatLevel += (THREAT_ASSESSMENT[t.type] || 2) * 2;
      });

      this.strategicMemory.enemyComposition = composition;
      this.strategicMemory.threatLevel = threatLevel;
    },

    decide: function () {
      const state = this.buildGraphState();
      if (!state) return;

      const now = performance.now();
      const { logits } = this.predict(state);
      const logitsData = Array.from(logits.dataSync());
      const mask = this.validActionMask();
      
      // 1. Получаем "сырое" лучшее действие от сети
      let bestActionIndex = 0;
      let maxVal = -Infinity;
      for (let i = 0; i < logitsData.length; i++) {
        if (mask[i] === 1 && logitsData[i] > maxVal) {
          maxVal = logitsData[i];
          bestActionIndex = i;
        }
      }
      const proposedAction = G_ACTIONS[bestActionIndex];

      // 2. ГИСТЕРЕЗИС: Проверяем, можем ли мы сменить стратегию
      let finalActionIndex = bestActionIndex;
      let finalAction = proposedAction;

      // Если это боевая или строительная стратегия, применяем таймер
      const isStrategic = ["tactic_all_in", "tactic_harass", "tactic_push", "tactic_defend", "build_base2", "build_barracks"].includes(proposedAction);
      
      if (isStrategic && this.lastStrategicChangeTime) {
        const timeSinceChange = now - this.lastStrategicChangeTime;
        if (timeSinceChange < CFG.MIN_COMMIT_MS) {
          // Если времени прошло мало, остаемся на старой стратегии (если она еще валидна)
          const lastStratIdx = AIDX[this.lastStrategicAction];
          if (lastStratIdx !== undefined && mask[lastStratIdx] === 1) {
            finalActionIndex = lastStratIdx;
            finalAction = this.lastStrategicAction;
          }
        } else {
          // Время вышло, фиксируем новое решение
          this.lastStrategicChangeTime = now;
          this.lastStrategicAction = proposedAction;
        }
      } else if (isStrategic) {
        // Первое стратегическое решение в матче
        this.lastStrategicChangeTime = now;
        this.lastStrategicAction = proposedAction;
      }

      // 3. Выполняем финальное действие
      const metrics = this.metrics();
      const executed = this.execute(finalAction, finalActionIndex, state);

      this.pending.push({ 
        time: now, state, action: finalAction, actionIndex: finalActionIndex, 
        executed: !!executed, 
        executedType: typeof executed === 'string' ? executed : null,
        before: metrics 
      });
      if (this.pending.length > 30) this.pending.shift();

      this.lastState = state;
      this.lastAction = finalAction;
    },
    evaluatePending: function (now) {
      if (!this.pending.length) return;
      const current = this.metrics();
      const keep = [];

      for (const p of this.pending) {
        let delay = 4000;
        if (["build_warehouse", "build_repair", "build_barracks", "build_beacon", "buildTurret", "expand"].includes(p.action)) delay = 12000;
        if (p.action === "hireFighter") delay = 7000;
        if (p.action === "hireAssault") delay = 12000;
        if (p.action === "hireElite") delay = 20000;

        if (now - p.time < delay) { keep.push(p); continue; }

        const reward = this.reward(p, current);
        const missionEntry = this.missionCache.find(m => m.action === p.action && !m.resolved);
        if (missionEntry) {
          missionEntry.replayEntry.reward += reward;
          missionEntry.resolved = true;
        } else if (Math.abs(reward) > 0.1) {
          this.replay.push({ X: p.state.X, A_distance: p.state.A_distance, A_threat: p.state.A_threat, actionIndex: p.actionIndex, reward });
        }
      }
      this.pending = keep;
    },

    reward: function (p, after) {
      if (after.baseHp <= 0) return -500.0; 
      if (!after.playerAlive) return 500.0;
      return (after.baseHp - p.before.baseHp) * 20.0; 
    },

    trainBatch: async function () {
      if (this.training || this.replay.length < CFG.BATCH_SIZE) return;
      this.training = true;

      const batch = [];
      for (let i = 0; i < CFG.BATCH_SIZE; i++) {
        const sample = this.replay.getRandom();
        if (sample && sample.X && sample.A_distance) batch.push(sample);
      }
      if (batch.length === 0) { this.training = false; return; }

      const B = batch.length;
      const xs = tf.tensor3d(batch.map(b => b.X), [B, CFG.MAX_NODES, CFG.NODE_FEATURES]);
      const as_dist = tf.tensor3d(batch.map(b => b.A_distance), [B, CFG.MAX_NODES, CFG.MAX_NODES]);  
      const as_threat = tf.tensor3d(batch.map(b => b.A_threat), [B, CFG.MAX_NODES, CFG.MAX_NODES]);  
      const act = tf.tensor1d(batch.map(b => b.actionIndex), "int32");
      const rew = tf.tensor1d(batch.map(b => b.reward), "float32");
      
      const oldLogProbsData = batch.map(b => (b.oldLogProb !== undefined && b.oldLogProb !== null) ? b.oldLogProb : 0.0);
      const oldValuesData = batch.map(b => (b.value !== undefined && b.value !== null) ? b.value : 0.0);
      const masks = batch.map(b => b.actionMask || new Array(G_ACTIONS.length).fill(1)); 
      
      const oldLogProbs = tf.tensor1d(oldLogProbsData, "float32");
      const oldValues = tf.tensor1d(oldValuesData, "float32");
      const maskTensor = tf.tensor2d(masks, [B, G_ACTIONS.length]);

      const globalFeatures = this.getGlobalFeatures();
      const globalBatchData = [];
      for (let i = 0; i < B; i++) {
          globalBatchData.push(Array.isArray(globalFeatures) ? [...globalFeatures] : new Array(CFG.GLOBAL_FEATURES).fill(0));
      }
      const globalBatch = tf.tensor2d(globalBatchData, [B, CFG.GLOBAL_FEATURES]);

      let loss = null;
      try {
        loss = this.optimizer.minimize(() => {
          const { logits, value } = this.model.forwardBatch(xs, as_dist, as_threat, globalBatch);  

          const inverseMask = maskTensor.sub(1).mul(-1e9); 
          const maskedLogits = logits.add(inverseMask);
          const logProbs = tf.logSoftmax(maskedLogits);
          
          const oneHot = tf.oneHot(act, G_ACTIONS.length);
          const newLogProbs = logProbs.mul(oneHot).sum(1);
          
          const ratio = tf.exp(newLogProbs.sub(oldLogProbs));
          const rawAdvantage = rew.sub(oldValues); 
          
          const mean = rawAdvantage.mean();
          const std = rawAdvantage.sub(mean).square().mean().add(1e-8).sqrt();
          const normAdv = rawAdvantage.sub(mean).div(std);
          
          const clippedRatio = tf.clipByValue(ratio, 0.8, 1.2);
          const surrogate1 = ratio.mul(normAdv);
          const surrogate2 = clippedRatio.mul(normAdv);
          const actorLoss = tf.minimum(surrogate1, surrogate2).mul(-1).mean(); 
          
          const valueClipped = oldValues.add(tf.clipByValue(value.squeeze().sub(oldValues), -0.5, 0.5));
          const criticLoss1 = value.squeeze().sub(rew).square();
          const criticLoss2 = valueClipped.sub(rew).square();
          const criticLoss = tf.maximum(criticLoss1, criticLoss2).mean();
          
          const probs = tf.softmax(maskedLogits);
          const entropy = probs.mul(logProbs).mul(-1).sum(1).mean();
          const entropyCoef = Math.max(0.01, 0.05 * (1 - Math.min(1, this.trainBatches / 5000))); 

          return actorLoss.add(criticLoss.mul(0.5)).sub(entropy.mul(entropyCoef));
        }, true, this.vars);

        const lv = await loss.data();
        this.trainBatches++;

        if (this.trainBatches % 10 === 0) {
          console.log("[GnnAI PPO]", { batch: this.trainBatches, loss: Number(lv[0].toFixed(5)), replay: this.replay.length });
        }
        if (this.trainBatches % CFG.SAVE_EVERY_BATCHES === 0) {
          await this.saveWeights();
        }
      } catch (e) {
        console.error("[GnnAI] train error", e);
      } finally {
        xs.dispose(); as_dist.dispose(); as_threat.dispose(); 
        act.dispose(); rew.dispose(); oldLogProbs.dispose(); oldValues.dispose(); 
        globalBatch.dispose(); maskTensor.dispose();
        if (loss) loss.dispose();
        this.training = false;
      }
    },

    buildGraphState: function () {
      if (!gameState || !aiBase || aiBase.health <= 0) return null;
      const raw = [{ obj: aiBase, type: "base", owner: "ai", x: aiBase.x, y: aiBase.y, hp: aiBase.health / aiBase.maxHealth, valid: 1 }];
      const candidates = [];

      for (const u of gameState.units) if (u && u.health > 0) candidates.push(u);
      for (const b of gameState.buildings) if (b && b.health > 0 && b !== aiBase) candidates.push(b);
      for (const r of gameState.resources) if (r && r.amount > 0 && Math.hypot(r.x - aiBase.x, r.y - aiBase.y) < 650) candidates.push(r);

      const scoreObj = (o) => {
        const d = Math.hypot(o.x - aiBase.x, o.y - aiBase.y);
        let s = 10000 - d;
        if (o.owner === "player") s += 5000;
        if (o.owner === "ai") s += 2500;
        if (["fighter", "assault", "elite"].includes(o.type)) s += 1800;
        if (o.type?.startsWith("turret")) s += 1600;
        if (["base", "base2", "base3", "barracks", "barracks2", "barracks3", "warehouse", "repairWorkshop", "beacon"].includes(o.type)) s += 1200;
        return s;
      };

      candidates.sort((a, b) => scoreObj(b) - scoreObj(a));
      for (const o of candidates.slice(0, CFG.MAX_NODES - 1)) {
        const maxHp = o.maxHealth || o.max || 1;
        raw.push({ obj: o, type: o.type || "unknown", owner: o.owner || "none", x: o.x, y: o.y, hp: Math.max(0, Math.min(1, (o.health ?? o.amount ?? 1) / maxHp)), valid: 1 });
      }

      while (raw.length < CFG.MAX_NODES) {
        raw.push({ obj: null, type: "pad", owner: "none", x: 0, y: 0, hp: 0, valid: 0 });
      }

      const X = raw.map(n => this.nodeFeatures(n));
      
      const A_distance = []; 
      const A_threat = [];   
      
      for (let i = 0; i < CFG.MAX_NODES; i++) {
        const row_dist = [];
        const row_threat = [];
        const ni = raw[i];
        
        for (let j = 0; j < CFG.MAX_NODES; j++) {
          const nj = raw[j];
          
          if (!ni.valid || !nj.valid) { 
            row_dist.push(0); 
            row_threat.push(0); 
            continue; 
          }
          if (i === j) { 
            row_dist.push(1); 
            row_threat.push(1); 
            continue; 
          }
          
          const d = Math.hypot(ni.x - nj.x, ni.y - nj.y);
          
          row_dist.push(d <= CFG.INTERACTION_RADIUS ? Math.exp(-d / CFG.INTERACTION_RADIUS) : 0);
          
          let threatValue = 0;
          if (ni.owner === "player" && nj.owner === "ai") {
            const enemyDps = this.getUnitDps(ni.type) || 0;
            if (d < 300) threatValue = (enemyDps / 100) * Math.exp(-d / 200);
          } else if (ni.owner === "ai" && nj.owner === "ai") {
            if (d < 200) threatValue = 0.5 * Math.exp(-d / 150); 
          } else if (ni.owner === "ai" && nj.owner === "player") {
            const myDps = this.getUnitDps(ni.type) || 0;
            if (d < 250) threatValue = (myDps / 100) * Math.exp(-d / 200);
          }
          
          row_threat.push(Math.min(1, threatValue));
        }
        
        const sum_dist = row_dist.reduce((a, b) => a + b, 0) || 1;
        const sum_threat = row_threat.reduce((a, b) => a + b, 0) || 1;
        
        A_distance.push(row_dist.map(v => v / sum_dist));
        A_threat.push(row_threat.map(v => v / sum_threat));
      }
      
      return { X, A_distance, A_threat, nodes: raw };
    },
    
    getUnitDps: function(type) {
      const dps = {
        fighter: 15, assault: 35, elite: 60,
        turret: 20, turret2: 40, turret3: 70,
        worker: 0, repairman: 0
      };
      return dps[type] || 0;
    },

    nodeFeatures: function (n) {
      if (!n || !n.valid) return new Array(CFG.NODE_FEATURES).fill(0);

      const t = n.type || "";
      const isBuilding = typeof Building !== "undefined" && n.obj instanceof Building;
      const isResource = ["gold", "silicon", "plasma"].includes(t);
      const isCombat = ["fighter", "assault", "elite"].includes(t);
      const isTurret = typeof t === "string" && t.startsWith("turret");
      
      // 🔥 НОРМИРОВКА: Приводим все пространственные признаки к диапазону [-1, 1] или [0, 1]
      const wW = CFG.WORLD_WIDTH || 2000;
      const wH = CFG.WORLD_HEIGHT || 2000;
      
      // Относительные координаты относительно базы (-1 до 1)
      const relX = (n.x - aiBase.x) / (wW * 0.5); 
      const relY = (n.y - aiBase.y) / (wH * 0.5);
      
      // Дистанция нормирована по диагонали карты
      const maxDist = Math.hypot(wW, wH);
      const dist = Math.hypot(n.x - aiBase.x, n.y - aiBase.y) / maxDist;
      const threat = n.owner === "player" ? (THREAT_ASSESSMENT[t] || 0) / 7 : 0;
      
      const isActive = n.obj && n.obj.active ? 1 : 0;
      const isUnderConstruction = n.obj && n.obj.builtAt && !n.obj.active ? 1 : 0;
      const isKeyBuilding = ["base", "base2", "base3", "barracks", "barracks2", "barracks3", "warehouse", "beacon"].includes(t) ? 1 : 0;
      const isMilitary = isCombat || isTurret ? 1 : 0;
      const isEconomic = t === "warehouse" || t === "repairWorkshop" ? 1 : 0;
      const isExpansion = t === "base2" || t === "base3" || t === "beacon" ? 1 : 0;
      const techLevel = t === "base3" || t === "barracks3" || t === "turret3" ? 3 : (t === "base2" || t === "barracks2" || t === "turret2" ? 2 : 1);

      let isUnderAttack = 0;
      if (n.obj && n.obj.owner === "ai" && n.obj.health > 0) {
        const enemiesNearby = gameState.units.some(u => u.owner === "player" && u.health > 0 && Math.hypot(u.x - n.obj.x, u.y - n.obj.y) < 150);
        if (enemiesNearby) isUnderAttack = 1;
      }

      let isIdle = 0;
      if (n.obj && n.obj.owner === "ai" && isCombat) {
        if (!n.obj.commandQueue || n.obj.commandQueue.length === 0) isIdle = 1;
      }

      let logisticsScore = 0;
      if (t === "warehouse" && n.obj) {
        let minResDist = 9999;
        gameState.resources.forEach(r => {
          if (r.amount > 0) {
            const d = Math.hypot(r.x - n.obj.x, r.y - n.obj.y);
            if (d < minResDist) minResDist = d;
          }
        });
        logisticsScore = Math.max(0, 1.0 - (minResDist / 1000));
      }

      return [
        n.valid ? 1 : 0, n.owner === "ai" ? 1 : 0, n.owner === "player" ? 1 : 0, n.hp || 0,
        relX, relY, dist, isCombat ? 1 : 0, isBuilding ? 1 : 0, t === "worker" ? 1 : 0,
        t === "fighter" ? 1 : 0, t === "assault" ? 1 : 0, t === "elite" ? 1 : 0, t.startsWith("base") ? 1 : 0,
        isTurret ? 1 : 0, t === "warehouse" ? 1 : 0, t === "beacon" ? 1 : 0, isResource ? 1 : 0,
        isBuilding && (t === "warehouse" || t === "repairWorkshop") ? 1 : 0, t === "repairWorkshop" ? 1 : 0,
        threat, n.obj?.range ? Math.min(1, n.obj.range / 500) : 0, n.obj?.fireRate ? Math.min(1, 1000 / n.obj.fireRate) : 0,
        this.strategicMemory.threatLevel / 30, isActive, isUnderConstruction, isKeyBuilding, isMilitary,
        isEconomic, isExpansion, techLevel / 3, isUnderAttack, isIdle, logisticsScore,
        (n.obj && n.obj.commandQueue && n.obj.commandQueue.length > 0) ? 1 : 0, 
        (n.obj && n.obj.attackCooldown !== undefined && n.obj.attackCooldownMax) 
            ? 1.0 - (n.obj.attackCooldown / n.obj.attackCooldownMax) : 1.0 
      ];
    },

    validActionMask: function () {
      const mask = new Array(G_ACTIONS.length).fill(0);
      const res = gameState.aiResources;
      
      const can = cost => {
        if (!res) return false;
        return (res.gold || 0) >= (cost.gold || 0) && 
               (res.silicon || 0) >= (cost.silicon || 0) && 
               (res.plasma || 0) >= (cost.plasma || 0);
      };

      const getCount = (type) => {
        const built = gameState.buildings.filter(b => b.owner === "ai" && b.type === type && b.health > 0).length;
        const queued = (window.buildQueue || []).filter(q => q.type === type).length;
        return built + queued;
      };

      const warehouses  = getCount("warehouse");
      const workshops   = getCount("repairWorkshop");
      const barracks    = getCount("barracks");      
      const turrets1    = getCount("turret");        
      const beacons     = getCount("beacon");
      const base2       = getCount("base2");         
      const barracks2   = getCount("barracks2");
      const turrets2    = getCount("turret2");       
      const base3       = getCount("base3");         
      const barracks3   = getCount("barracks3");
      const turrets3    = getCount("turret3");       

      mask[AIDX.idle] = 1; 

      if (can(WAREHOUSE_COST)) {
        mask[AIDX.build_warehouse] = 1;
      }

      if (warehouses >= 1 && can(REPAIR_WORKSHOP_COST)) {
        mask[AIDX.build_repair] = 1;
      }

      if (barracks >= 1 && can(BEACON_COST)) {
        mask[AIDX.build_beacon] = 1;
      }

      if (workshops >= 1 && barracks === 0 && can(BARRACKS_COST)) {
        mask[AIDX.build_barracks] = 1;
      }

      if (beacons >= 1 && base2 === 0 && can(BASE2_COST)) {
        mask[AIDX.build_base2] = 1;
      }

      if (base2 >= 1 && barracks2 === 0 && can(BARRACKS2_COST)) {
        mask[AIDX.build_barracks2] = 1;
      }

      if (barracks2 >= 1 && base3 === 0 && can(BASE3_COST)) {
        mask[AIDX.build_base3] = 1;
      }

      if (base3 >= 1 && barracks3 === 0 && can(BARRACKS3_COST)) {
        mask[AIDX.build_barracks3] = 1;
      }
      
      if (barracks >= 1 && can(TURRET_COST)) {
        mask[AIDX.build_turret1] = 1;
      }

      if (barracks2 >= 1 && can(TURRET2_COST)) {
        mask[AIDX.build_turret2] = 1;
      }

      if (barracks3 >= 1 && can(TURRET3_COST)) {
        mask[AIDX.build_turret3] = 1;
      }

      const hasWarehouseWithSpace = gameState.buildings.some(b => b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5));
      if (hasWarehouseWithSpace && can(WORKER_COST)) mask[AIDX.hireWorker] = 1;

      const hasWorkshopWithSpace = gameState.buildings.some(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active && (b.repairman || 0) < (b.capacity || 3));
      if (hasWorkshopWithSpace && can(REPAIRMAN_COST)) mask[AIDX.hireRepairman] = 1;

      if (barracks >= 1 && can(FIGHTER_COST)) mask[AIDX.hireFighter] = 1;
      if (barracks2 >= 1 && can(ASSAULT_COST)) mask[AIDX.hireAssault] = 1;
      if (barracks3 >= 1 && can(ELITE_COST)) mask[AIDX.hireElite] = 1;

      const armySize = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0).length;
      if (armySize >= 2) {
        mask[AIDX.defend] = 1; 
        mask[AIDX.tactic_all_in] = 1; 
        mask[AIDX.tactic_harass] = 1; 
        mask[AIDX.tactic_push] = 1; 
        mask[AIDX.tactic_defend] = 1; 
      }

      if (mask.every(v => v === 0)) {
        mask[AIDX.idle] = 1;
      }
      
      return mask;
    },

    sampleMasked: function (logits, mask, temperature = 1.0) {
      const maskedLogits = logits.map((v, i) => mask[i] === 1 ? v / temperature : -1e9);
      const maxLogit = Math.max(...maskedLogits);
      const expLogits = maskedLogits.map(v => Math.exp(v - maxLogit));
      const sumExp = expLogits.reduce((a, b) => a + b, 0) || 1;
      const probs = expLogits.map(v => v / sumExp);
      let r = Math.random();
      for (let i = 0; i < probs.length; i++) {
        r -= probs[i];
        if (r <= 0) return i;
      }
      return probs.length - 1;
    },

    execute: function (action, actionIndex, state) {
      const activeAttacks = this.missionCache.filter(m => !m.resolved && m.intent.type === "attack").length;
      if (action.startsWith("attack") && activeAttacks >= 2) return false;
      
      try {
        if (action === "defend") {
          const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
          if (freeUnits.length === 0) return false;
          const anchor = this.threatAnchor() || aiBase;
          const defenderIds = freeUnits.map(u => u.id);
          
          freeUnits.forEach(u => {
            u.defending = true;
            u.commandQueue = [{ type: "move", x: anchor.x + (Math.random() - 0.5) * 150, y: anchor.y + (Math.random() - 0.5) * 150 }];
          });
          this.registerAction(action, state, { type: "defend", anchor: anchor.id || "aiBase", units: defenderIds.length, unitIds: defenderIds }, actionIndex);
          return true;
        }

        if (action.startsWith("tactic_")) {
          const freeUnits = gameState.units.filter(u => 
            u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && 
            u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0)
          );
          
          if (freeUnits.length === 0) {
             this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -1.0 });
             return false;
          }

          let target = null;
          let forcePercentage = 0.5; 

          if (action === "tactic_all_in") {
            target = gameState.buildings.find(b => b.owner === "player" && b.type === "base"); 
            forcePercentage = 0.90; 
          } 
          else if (action === "tactic_harass") {
            const vulnerable = [...gameState.units.filter(u => u.owner === "player" && u.type === "worker"), 
                                ...gameState.buildings.filter(b => b.owner === "player" && (b.type === "warehouse" || b.type === "repairWorkshop"))];
            target = vulnerable.length > 0 ? vulnerable[0] : gameState.buildings.find(b => b.owner === "player" && b.type === "base");
            forcePercentage = 0.30; 
          } 
          else if (action === "tactic_push") {
            const enemies = [...gameState.units.filter(u => u.owner === "player" && u.health > 0), 
                             ...gameState.buildings.filter(b => b.owner === "player" && b.health > 0)];
            target = enemies.reduce((best, o) => Math.hypot(o.x - aiBase.x, o.y - aiBase.y) < Math.hypot(best.x - aiBase.x, best.y - aiBase.y) ? o : best);
            forcePercentage = 0.60;
          } 
          else if (action === "tactic_defend") {
            const threats = gameState.units.filter(u => u.owner === "player" && u.health > 0);
            target = threats.reduce((closest, u) => Math.hypot(u.x - aiBase.x, u.y - aiBase.y) < Math.hypot(closest.x - aiBase.x, closest.y - aiBase.y) ? u : closest, {x: aiBase.x, y: aiBase.y});
            forcePercentage = 0.80; 
          }

          if (!target) return false;

          freeUnits.sort((a, b) => {
             if (action === "tactic_harass") return (a.type === "fighter" ? -1 : 1); 
             return 0; 
          });

          const attackersCount = Math.max(1, Math.ceil(freeUnits.length * forcePercentage));
          const attackers = freeUnits.slice(0, attackersCount);
          const attackerIds = attackers.map(u => u.id);

          attackers.forEach(u => {
            u.defending = false;
            const tx = target.x + (Math.random() - 0.5) * 100;
            const ty = target.y + (Math.random() - 0.5) * 100;
            
            u.commandQueue = [{ type: "move", x: tx, y: ty }, { type: "attack", target: target }];
            if (typeof processCommandQueue === "function") processCommandQueue(u);
          });

          this.registerAction(action, state, { 
            type: "attack", 
            tactic: action,
            targetId: target.id || "ground", 
            targetType: target.type,
            units: attackersCount, 
            unitIds: attackerIds 
          }, actionIndex);
          
          return true;
        }

        if (action === "build_warehouse") {
          return this.tryBuildSpecific("warehouse", WAREHOUSE_COST, action, actionIndex, state);
        }
        if (action === "build_repair") {
          return this.tryBuildSpecific("repairWorkshop", REPAIR_WORKSHOP_COST, action, actionIndex, state);
        }
        if (action === "build_barracks") {
          return this.tryBuildSpecific("barracks", BARRACKS_COST, action, actionIndex, state);
        }
        if (action === "build_beacon") {
          return this.tryBuildSpecific("beacon", BEACON_COST, action, actionIndex, state);
        }
        
        if (action === "buildTurret") {
          const pos = this.findBuildPos(this.threatAnchor() || aiBase, "turret");
          if (pos) {
            this.registerAction(action, state, { type: "build", buildingType: "turret" }, actionIndex);
            return !!scheduleAIBuilding("turret", pos.x, pos.y, 0);
          }
          this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.3 });
          return false;
        }

        if (action === "hireWorker") {
          const w = gameState.buildings.find(b => b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5));
          if (!w) return false;
          const res = gameState.aiResources;
          const cost = WORKER_COST;
          const canAfford = (res.gold || 0) >= (cost.gold || 0) && (res.silicon || 0) >= (cost.silicon || 0) && (res.plasma || 0) >= (cost.plasma || 0);
          if (!canAfford) return false;

          if (typeof aiHireWorker === "function") {
            aiHireWorker(w);
          } else {
            w.workers = (w.workers || 0) + 1;
            res.gold -= cost.gold || 0; res.silicon -= cost.silicon || 0; res.plasma -= cost.plasma || 0;
            if (typeof getUnitFromPool === "function" && typeof addUnit === "function") {
              const worker = getUnitFromPool("worker", "ai", w.x, w.y);
              worker.homeWarehouse = w;
              addUnit(worker);
            }
            if (typeof updateResourceUI === "function") updateResourceUI();
          }
          this.registerAction(action, state, { type: "hire", unitType: "worker" }, actionIndex);
          return true;
        }
        
        if (action === "hireRepairman") {
          const r = gameState.buildings.find(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active && (b.repairman || 0) < (b.capacity || 3));
          if (!r) return false;
          const res = gameState.aiResources;
          const cost = REPAIRMAN_COST;
          const canAfford = (res.gold || 0) >= (cost.gold || 0) && (res.silicon || 0) >= (cost.silicon || 0) && (res.plasma || 0) >= (cost.plasma || 0);
          if (!canAfford) return false;

          if (typeof aiHireRepairMan === "function") {
            aiHireRepairMan(r);
          } else {
            r.repairman = (r.repairman || 0) + 1;
            res.gold -= cost.gold || 0; res.silicon -= cost.silicon || 0; res.plasma -= cost.plasma || 0;
            if (typeof getUnitFromPool === "function" && typeof addUnit === "function") {
              const repairman = getUnitFromPool("repairman", "ai", r.x, r.y);
              repairman.homeWorkshop = r;
              addUnit(repairman);
            }
            if (typeof updateResourceUI === "function") updateResourceUI();
          }
          this.registerAction(action, state, { type: "hire", unitType: "repairman" }, actionIndex);
          return true;
        }
        
        if (action === "hireFighter" || action === "hireAssault" || action === "hireElite") {
          const bType = action === "hireFighter" ? "barracks" : (action === "hireAssault" ? "barracks2" : "barracks3");
          const uType = action === "hireFighter" ? "fighter" : (action === "hireAssault" ? "assault" : "elite");
          const cost = action === "hireFighter" ? FIGHTER_COST : (action === "hireAssault" ? ASSAULT_COST : ELITE_COST);
          
          const hasRequiredBuilding = gameState.buildings.some(b => b.owner === "ai" && b.type === bType && b.health > 0 && b.active);
          
          if (hasRequiredBuilding && this.enqueueUnit(uType, bType, cost)) {
            this.registerAction(action, state, { type: "hire", unitType: uType }, actionIndex);
            return true;
          }
          
          this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -2.0 });
          return false;
        }
        
        if (action === "expand") {
          let anchor = aiBase;
          let maxDist = 0;
          gameState.buildings.forEach(b => {
            if (b.owner === "ai" && b.active) {
              const d = Math.hypot(b.x - aiBase.x, b.y - aiBase.y);
              if (d > maxDist) { maxDist = d; anchor = b; }
            }
          });
          const pos = this.findBuildPos(anchor, "beacon", 250, 350);
          if (pos) {
            this.registerAction(action, state, { type: "build", buildingType: "beacon" }, actionIndex);
            return !!scheduleAIBuilding("beacon", pos.x, pos.y, 0);
          }
          this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.3 });
          return false;
        }
        
        if (action === "idle") {
          this.registerAction(action, state, { type: "idle" }, actionIndex);
          return true;
        }

      } catch (e) {
        console.warn("[GnnAI execute error]", action, e);
      }
      return false;
    },

    tryBuildSpecific: function(buildingType, cost, action, actionIndex, state) {
      const res = gameState.aiResources;
      const canAfford = (res.gold || 0) >= (cost.gold || 0) && 
                        (res.silicon || 0) >= (cost.silicon || 0) && 
                        (res.plasma || 0) >= (cost.plasma || 0);
      
      if (!canAfford) {
        this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.3 });
        return false;
      }

      let anchor = aiBase;
      if (buildingType === "beacon") {
        let maxDist = 0;
        gameState.buildings.forEach(b => {
          if (b.owner === "ai" && b.active) {
            const d = Math.hypot(b.x - aiBase.x, b.y - aiBase.y);
            if (d > maxDist) { maxDist = d; anchor = b; }
          }
        });
      } else if (buildingType === "repairWorkshop") {
        const wh = gameState.buildings.find(b => b.owner === "ai" && b.type === "warehouse" && b.health > 0);
        if (wh) anchor = wh;
      } else if (buildingType === "barracks") {
        const wh = gameState.buildings.find(b => b.owner === "ai" && b.type === "warehouse" && b.health > 0);
        if (wh) anchor = wh;
      }

      const pos = this.findBuildPos(anchor, buildingType, 70, 240);
      if (!pos) {
        this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.3 });
        return false;
      }

      const scheduled = scheduleAIBuilding(buildingType, pos.x, pos.y, 0);
      if (scheduled) {
        this.registerAction(action, state, { type: "build", buildingType: buildingType }, actionIndex);
        console.log(`[GnnAI] 🏗️ Строим: ${buildingType}`);
        return true;
      }
      return false;
    },

    enqueueUnit: function (type, buildingType, cost) {
      const b = gameState.buildings.find(x => x.owner === "ai" && x.type === buildingType && x.active && (!x.productionQueue || x.productionQueue.length < (x.productionLimit || 3)));
      if (!b || !canSpendResources(cost, "ai") || typeof aiEnqueueMilitaryUnit !== "function") return false;
      if (!aiEnqueueMilitaryUnit(type, b)) return false;
      gameState.aiResources.gold -= cost.gold || 0;
      gameState.aiResources.silicon -= cost.silicon || 0;
      gameState.aiResources.plasma -= cost.plasma || 0;
      if (typeof updateResourceUI === "function") updateResourceUI();
      return true;
    },

    autoEconomy: function () {
      if (window.fullRLMode) return;
      
      if (typeof aiHireWorker !== "function") return;
      for (const b of gameState.buildings) {
        if (b.owner !== "ai" || !b.active) continue;
        
        if (b.type === "warehouse") {
          const maxWorkers = b.maxDeliveryWorkers || 5;
          const currentWorkers = b.workers || 0;
          
          if (currentWorkers < Math.ceil(maxWorkers / 2)) {
            let guard = 0;
            while (currentWorkers + guard < maxWorkers && guard < 1 && canSpendResources(WORKER_COST, "ai")) {
              aiHireWorker(b);
              guard++;
            }
          }
        }
        
        if (b.type === "repairWorkshop" && typeof aiHireRepairMan === "function") {
          const woundedUnits = gameState.units.filter(u => 
            u.owner === "ai" && u.health > 0 && u.health < u.maxHealth
          ).length;
          
          const maxRepairmen = b.capacity || 3;
          const currentRepairmen = b.repairman || 0;
          
          if (woundedUnits > 0 && currentRepairmen < maxRepairmen) {
            let guard = 0;
            while (currentRepairmen + guard < maxRepairmen && guard < 1 && canSpendResources(REPAIRMAN_COST, "ai")) {
              aiHireRepairMan(b);
              guard++;
            }
          }
        }
      }
    }, 

    threatAnchor: function () {
      const anchors = gameState.buildings.filter(b => b.owner === "ai" && ["base", "base2", "base3", "beacon", "warehouse", "repairWorkshop", "barracks", "barracks2", "barracks3"].includes(b.type) && b.health > 0);
      if (!anchors.length) return aiBase;
      const enemies = [...gameState.units.filter(u => u.owner === "player" && u.health > 0), ...gameState.buildings.filter(b => b.owner === "player" && b.health > 0)];
      let best = aiBase, bestScore = -Infinity;

      for (const a of anchors) {
        let score = (1 - a.health / a.maxHealth) * 150 + (a.type.startsWith("base") ? 100 : 50);
        for (const e of enemies) {
          const d = Math.hypot(a.x - e.x, a.y - e.y);
          if (d < CFG.BASE_THREAT_RADIUS) score += ((CFG.BASE_THREAT_RADIUS - d) / CFG.BASE_THREAT_RADIUS) * 200;
        }
        const existingDefenders = gameState.units.filter(u => u.owner === "ai" && u.defending && Math.hypot(u.x - a.x, u.y - a.y) < 200).length;
        score -= existingDefenders * 30;
        if (score > bestScore) { bestScore = score; best = a; }
      }
      return best;
    },

    findBuildPos: function (anchor, type, minR = 80, maxR = 350) { 
      if (!anchor) anchor = aiBase;
      
      for (let i = 0; i < 60; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = minR + Math.random() * (maxR - minR);
        const x = anchor.x + Math.cos(a) * r;
        const y = anchor.y + Math.sin(a) * r;
        
        if (x < 60 || y < 60 || x > worldWidth - 60 || y > worldHeight - 60) continue;
        if (typeof isValidAiBuildLocation === "function" && !isValidAiBuildLocation(x, y)) continue;

        const dims = { warehouse: [40, 30], repairWorkshop: [40, 30], barracks: [50, 30], barracks2: [50, 30], barracks3: [50, 30], turret: [20, 20], turret2: [20, 22], turret3: [20, 22], beacon: [40, 50], base2: [55, 40], base3: [55, 40] }[type] || [30, 30];
        const rect = { left: x - dims[0] / 2, top: y - dims[1] / 2, right: x + dims[0] / 2, bottom: y + dims[1] / 2 };
        
        let bad = false;
        for (const b of gameState.buildings) {
          const br = { left: b.x - b.width / 2 - 10, top: b.y - b.height / 2 - 10, right: b.x + b.width / 2 + 10, bottom: b.y + b.height / 2 + 10 }; 
          if (typeof rectsOverlap === "function" && rectsOverlap(rect, br)) { bad = true; break; }
        }
        if (!bad) return { x, y };
      }

      console.warn(`[GnnAI] ⚠️ Рандом не нашел место для ${type}, использую жесткий поиск`);
      const offsets = [
        { x: anchor.x + 150, y: anchor.y }, { x: anchor.x - 150, y: anchor.y },
        { x: anchor.x, y: anchor.y + 150 }, { x: anchor.x, y: anchor.y - 150 },
        { x: anchor.x + 150, y: anchor.y + 150 }
      ];

      const dims = { warehouse: [40, 30], repairWorkshop: [40, 30], barracks: [50, 30], barracks2: [50, 30], barracks3: [50, 30], turret: [20, 20], turret2: [20, 22], turret3: [20, 22], beacon: [40, 50], base2: [55, 40], base3: [55, 40] }[type] || [30, 30];

      for (const pos of offsets) {
        if (pos.x < 60 || pos.y < 60 || pos.x > worldWidth - 60 || pos.y > worldHeight - 60) continue;
        
        const rect = { left: pos.x - dims[0] / 2, top: pos.y - dims[1] / 2, right: pos.x + dims[0] / 2, bottom: pos.y + dims[1] / 2 };
        let bad = false;
        for (const b of gameState.buildings) {
          const br = { left: b.x - b.width / 2 - 10, top: b.y - b.height / 2 - 10, right: b.x + b.width / 2 + 10, bottom: b.y + b.height / 2 + 10 };
          if (typeof rectsOverlap === "function" && rectsOverlap(rect, br)) { bad = true; break; }
        }
        if (!bad) {
          console.log(`[GnnAI] ✅ Найдено жесткое место для ${type}:`, pos);
          return pos;
        }
      }

      console.error(`[GnnAI] ❌ КРИТИЧЕСКАЯ ОШИБКА: Невозможно найти место для ${type}!`);
      return null;
    },

    metrics: function () {
      const baseHp = aiBase && aiBase.maxHealth ? aiBase.health / aiBase.maxHealth : 0;
      const enemyNear = gameState.units.filter(u => u.owner === "player" && u.health > 0 && aiBase && Math.hypot(u.x - aiBase.x, u.y - aiBase.y) < CFG.BASE_THREAT_RADIUS).length;
      const aiArmy = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0).length;
      const enemyArmy = gameState.units.filter(u => u.owner === "player" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0).length;
      
      let techLevel = 1;
      if (gameState.buildings.some(b => b.owner === "ai" && ["base2", "barracks2", "turret2"].includes(b.type))) techLevel = 2;
      if (gameState.buildings.some(b => b.owner === "ai" && ["base3", "barracks3", "turret3"].includes(b.type))) techLevel = 3;

      const aiBuildings = gameState.buildings.filter(b => b.owner === "ai" && b.health > 0).length;
      const aiTurrets = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0).length;
      const aiWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.health > 0).length;
      const playerAlive = gameState.buildings.some(b => b.owner === "player" && b.health > 0);
      
      const ar = gameState.aiResources || {};
      const resTotal = (ar.gold || 0) + (ar.silicon || 0) + (ar.plasma || 0);
      const ecoEfficiency = resTotal > 0 ? (aiArmy / (resTotal / 100)) : 0;

      return { 
        baseHp, enemyNear, aiArmy, enemyArmy, techLevel, aiBuildings, aiTurrets, aiWarehouses, playerAlive, 
        resTotal, ecoEfficiency,
        res: { gold: Math.round(ar.gold || 0), silicon: Math.round(ar.silicon || 0), plasma: Math.round(ar.plasma || 0) } 
      };
    },
 
    getUnlocks: function () {
      const hasBuilding = (type) => gameState.buildings.some(b => b.owner === "ai" && b.type === type && b.health > 0 && b.active);
      const hasUnit = (type) => gameState.units.some(u => u.owner === "ai" && u.type === type && u.health > 0);
      
      return {
        tier0_start: true,
        tier1_economy: hasBuilding("warehouse") && hasBuilding("repairWorkshop"),
        tier2_basicMilitary: hasBuilding("barracks"),
        tier3_armyControl: hasUnit("fighter") || hasUnit("assault") || hasUnit("elite"),
        tier4_advanced: hasBuilding("base2") && hasBuilding("barracks2"),
        tier5_lateGame: hasBuilding("base3") && hasBuilding("barracks3")
      };
    },

    startEpisode: function (mode) {
      this.episode = { mode, start: performance.now(), firstThreatAt: null, firstDefenseAt: null, minBaseHp: 1, actions: {}, ended: false, result: null };
      this.episodeReport = { actions: {}, timeline: [] };
      this.episodeAchievements = {
          firstBarracks: false, firstBase2: false, firstBarracks2: false,
          firstBase3: false, firstAssault: false, firstElite: false
      };
    },

    benchmarkTick: function (mode, action) {
      if (gameMode !== mode || !this.episode || this.episode.mode !== mode || this.episode.ended) return;
      const m = this.metrics();
      const now = performance.now();
      this.episode.minBaseHp = Math.min(this.episode.minBaseHp, m.baseHp);
      if (action) this.episode.actions[action] = (this.episode.actions[action] || 0) + 1;
      if (this.episode.firstThreatAt === null && m.enemyNear > 0) this.episode.firstThreatAt = now;
    },

    finishEpisode: function (result) {
      if (!this.episode || this.episode.ended) return;
      this.episode.ended = true;
      this.episode.result = result;
      this.episode.duration = performance.now() - this.episode.start;

      const row = {
        mode: this.episode.mode, result, date: new Date().toISOString(),
        durationSec: +(this.episode.duration / 1000).toFixed(2),
        minBaseHp: +this.episode.minBaseHp.toFixed(3), actions: { ...this.episode.actions }
      };
      const stats = this.readStats();
      stats.push(row);
      while (stats.length > 80) stats.shift();
      localStorage.setItem(CFG.STATS_KEY, JSON.stringify(stats));
      console.log("[GnnAI benchmark] saved", row);
      this.printEpisodeReport(result);
      this.stats();
    },

    readStats: function () {
      try { return JSON.parse(localStorage.getItem(CFG.STATS_KEY) || "[]"); } catch { return []; }
    },

    stats: function () {
      const rows = this.readStats();
      const by = {};
      for (const r of rows) { if (!by[r.mode]) by[r.mode] = []; by[r.mode].push(r); }
      const summary = {};
      for (const mode of Object.keys(by)) {
        const list = by[mode];
        const hp = list.map(x => x.minBaseHp).filter(x => typeof x === "number");
        const wins = list.filter(x => x.result === "win").length;
        summary[mode] = { episodes: list.length, wins, winRate: +(wins / list.length).toFixed(3), avgMinBaseHp: hp.length ? +(hp.reduce((a, b) => a + b, 0) / hp.length).toFixed(3) : null };
      }
      console.table(summary);
      return summary;
    },

    checkEnd: async function () {
      if (gameState.gameEnded) return;

      const aiBaseAlive = gameState.buildings.some(b => b.owner === "ai" && b.type === "base" && b.health > 0);
      const playerBaseAlive = gameState.buildings.some(b => b.owner === "player" && b.type === "base" && b.health > 0);

      if (!aiBaseAlive || !playerBaseAlive) {
        gameState.gameEnded = true;
        console.log("[GnnAI] 💾 Игра завершена. Сохранение весов...");
        await this.saveWeights();

        if (!aiBaseAlive) {
          this.finishEpisode("loss");
        } else {
          this.finishEpisode("win");
        }

        if (window.autoRestartEnabled) {
          setTimeout(() => {
            console.log("[Curriculum] 🔄 Перезагрузка страницы для 100% чистой новой игры...");
            localStorage.setItem('gnn_auto_restart', 'true'); 
            window.location.reload();
          }, 2000);
        } else {
          if (typeof showVictoryScreen === "function") {
            showVictoryScreen(!aiBaseAlive ? "GNN ИИ проиграл." : "GNN ИИ победил!");
          }
        }
      }
    },

    saveWeights: async function () {
      if (!this.vars.length) return;
      try {
        const data = this.vars.map(v => ({ shape: v.shape, values: Array.from(v.dataSync()) }));
        await WeightDB.save(CFG.STORAGE_KEY, { version: 6.6, batches: this.trainBatches, data, backend: tf.getBackend(), actionsCount: G_ACTIONS.length });
        console.log("[GnnAI] 💾 Веса успешно сохранены в IndexedDB (v6.6)");
      } catch (e) { 
        console.error("[GnnAI] ❌ Ошибка сохранения весов:", e); 
      }
    },

    loadWeights: async function () {
      try {
        const obj = await WeightDB.load(CFG.STORAGE_KEY);
        if (!obj) { 
          console.log("[GnnAI] Записей в IndexedDB не найдено. Инициализация с нуля."); 
          return false; 
        }
        if (!Array.isArray(obj.data)) { 
          console.warn("[GnnAI] Ошибка формата: obj.data не является массивом", obj); 
          return false; 
        }
        if (obj.data.length !== this.vars.length) {
          console.warn(`[GnnAI] Несовпадение архитектуры: сохранено ${obj.data.length} переменных, ожидается ${this.vars.length}`);
          return false;
        }
        if (obj.actionsCount && obj.actionsCount !== G_ACTIONS.length) {
          console.warn(`[GnnAI] ⚠️ Старая архитектура (${obj.actionsCount} действий) несовместима с v6.7 (${G_ACTIONS.length} действий). Сброс весов.`);
          return false;
        }

        const hasInvalidWeights = obj.data.some(w => w.values.some(v => !isFinite(v)));
        if (hasInvalidWeights) {
          console.warn("[GnnAI] ⚠️ Сохраненные веса повреждены (NaN/Infinity). Инициализация с нуля.");
          return false;
        }

        tf.tidy(() => { 
          obj.data.forEach((w, i) => { this.vars[i].assign(tf.tensor(w.values, w.shape)); }); 
        });
        
        this.trainBatches = obj.batches || 0;
        console.log(`[GnnAI] ✅ Веса успешно загружены из IndexedDB (batch: ${this.trainBatches})`);
        return true;
      } catch (e) { 
        console.error("[GnnAI] Ошибка при загрузке весов:", e);
        return false; 
      }
    },

    printEpisodeReport: function(result) {
      console.group(`📊 [GnnAI] ПОЛНЫЙ ОТЧЕТ О МАТЧЕ: ${result.toUpperCase()}`);
      if (!this.episodeReport) { console.groupEnd(); return; }
      
      console.log("🎯 Общее распределение действий:", this.episodeReport.actions);
      const keyEvents = this.episodeReport.timeline.filter(e => 
        e.detail === "barracks" || e.detail === "barracks2" || e.detail === "barracks3" || 
        e.detail === "base2" || e.detail === "base3" || e.detail === "warehouse" || 
        e.detail === "repairWorkshop" || e.detail === "beacon" ||
        e.detail === "fighter" || e.detail === "assault" || e.detail === "elite" ||
        e.action === "attack_front" || e.action === "attack_flank" || e.action === "attack_feint"
      );
      
      if (keyEvents.length > 0) {
        console.log("🏗️ Ключевые события (постройки, найм, атаки):");
        console.table(keyEvents, ["time", "action", "detail", "resources", "army", "tech"]);
      } else {
        console.log("⚠️ Ключевых событий не зафиксировано.");
      }
      
      const m = this.metrics();
      console.log(`💰 Финальная экономика: Ресурсы: ${m.resTotal}, Армия: ${m.aiArmy}, Технологий: Тир ${m.techLevel}`);
      console.groupEnd();
    },

    reset: function () {
      WeightDB.init().then(() => {
        const req = indexedDB.deleteDatabase('GnnAI_Weights_DB');
        req.onsuccess = () => {
          console.log("[GnnAI] Веса и база данных сброшены. Перезагрузка.");
          location.reload();
        };
        req.onerror = () => console.error("[GnnAI] Ошибка при сбросе базы данных");
      });
    }
  };

  window.buildQueue = window.buildQueue || [];
  window.scheduleAIBuilding = function (type, x, y, delay = 0) {
    if (typeof canBuild === "function" && !canBuild(type)) return false;
    window.buildQueue.push({ type, x, y, plannedAt: performance.now(), delay });
    return true;
  };

  window.processBuildQueue = function () {
    const now = performance.now();
    for (let i = 0; i < window.buildQueue.length; i++) {
      const item = window.buildQueue[i];
      if (now - item.plannedAt >= item.delay) {
        if (typeof aiPlaceBuilding !== "function") { window.buildQueue.splice(i, 1); i--; continue; }
        const built = aiPlaceBuilding(item.type, item.x, item.y);
        if (built) { window.buildQueue.splice(i, 1); i--; } else { item.plannedAt = now + 2000; }
      }
    }
  };

  async function startGnnGame() {
    if (typeof stopAllIntervals === "function") stopAllIntervals();
    if (window.__aiSaleQueueInterval) { clearInterval(window.__aiSaleQueueInterval); window.__aiSaleQueueInterval = null; }

    window.processAIMilitaryProductionQueue = function() {};
    window.updateAIProductionQueues = function() {};
    window.attemptToEnqueueMilitaryOrders = function() {};
    window.attemptToHireWorkers = function() {};
    window.attemptToHireRepairman = function() {};
    window.processAISaleQueue = function() {};
    window.aiLogic = function() {};

    await GnnAI.init();
    
    const elementsToHide = [
      document.getElementById("loadingScreen"),
      document.getElementById("welcomeScreen"),
      document.getElementById("mainMenu"),
      document.querySelector(".overlay"),
      document.querySelector(".menu-screen"),
      document.querySelector(".welcome-screen")
    ];
    
    elementsToHide.forEach(el => {
      if (el) {
        el.style.display = "none";
        el.style.visibility = "hidden"; 
      }
    });

    const gnnBtn = document.getElementById("gnnButton");
    if (gnnBtn) gnnBtn.style.display = "none";

    gameStarted = true; 
    gameMode = "gnn";
    if (typeof window.neuralAIActive !== "undefined") window.neuralAIActive = false;
    isPaused = false; playerId = "player"; opponentId = null;
    gameState.gameEnded = false;
    gameState.buildings = []; gameState.units = []; gameState.fragments = []; gameState.particles = [];
    gameState.resources = []; gameState.bullets = []; gameState.lasers = []; gameState.capturePoints = [];
    gameState.resourceTokens = []; gameState.recentBuilds = []; gameState.recentLosses = [];
    gameState.attackers = []; gameState.repairmen = []; gameState.defenders = [];
    gameState.playerResources = { gold: 100, silicon: 100, plasma: 50 };
    gameState.aiResources = { gold: 100, silicon: 100, plasma: 50 };
    gameState.playerScore = 0; selectedUnits = [];

    const m = 300;
    playerBase = new Building("base", "player", m, m);
    aiBase = new Building("base", "ai", worldWidth - m, worldHeight - m);
    playerBase.active = true; aiBase.active = true;
    gameState.buildings.push(playerBase, aiBase);

    if (typeof generateResources === "function") generateResources(100);
    if (typeof initFogOfWar === "function") initFogOfWar();

    camera.offsetX = canvas.width / 2 - playerBase.x * camera.scale;
    camera.offsetY = canvas.height / 2 - playerBase.y * camera.scale;
    const controls = document.getElementById("controlsWrapper");
    if (controls) controls.style.display = "block";

    GnnAI.startEpisode("gnn");
    if (window.AIScheduler) AIScheduler.start("gnn");
    else {
      if (GnnAI._fallback) clearInterval(GnnAI._fallback);
      GnnAI._fallback = setInterval(() => {
        tf.tidy(() => { GnnAI.tick(); });
      }, 250);
    }
    
    if (typeof window.startTrainingBot === "function") {
      window.startTrainingBot();
    }

    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
    console.log("[GnnAI] 🚀 Матч начат (v6.7: Smooth & Normalized");
    
    setTimeout(() => {
      document.querySelectorAll('div').forEach(div => {
        if (div.style.zIndex >= 100 && div.offsetWidth > window.innerWidth * 0.5) {
           if (!div.id.includes('gnn-training') && div.tagName !== 'CANVAS') {
             div.style.display = 'none';
           }
        }
      });
    }, 300);
  }

  function addMenuButton() {
    const loading = document.getElementById("loadingScreen");
    if (!loading || document.getElementById("gnnButton")) return;
    const btn = document.createElement("button");
    btn.id = "gnnButton"; btn.innerText = "Граф ИИ v6.7 (Smooth & Normalized)";
    btn.style.cssText = "font-family: 'Orbitron', sans-serif; font-size: 18px; padding: 12px 28px; border: 2px solid #00ff99; color: #00ff99; background: rgba(0,255,120,0.08); border-radius: 50px; box-shadow: 0 0 15px rgba(0,255,120,0.5); cursor: pointer; transition: all 0.3s ease; z-index: 10; margin-top: 10px;";
    btn.onmouseenter = () => { btn.style.background = "rgba(0,255,120,0.2)"; btn.style.transform = "scale(1.05)"; };
    btn.onmouseleave = () => { btn.style.background = "rgba(0,255,120,0.08)"; btn.style.transform = "scale(1)"; };
    btn.onclick = startGnnGame;
    const neural = document.getElementById("neuralButton");
    if (neural && neural.parentNode === loading) neural.insertAdjacentElement("afterend", btn);
    else loading.appendChild(btn);
  }

  function patchScheduler() {
    if (!window.AIScheduler || AIScheduler.__gnnPatched) return;
    AIScheduler.__gnnPatched = true;
    const origTick = AIScheduler.tick.bind(AIScheduler);
    AIScheduler.tick = function () {
      if (this.mode === "gnn") {
        if (!this.running || typeof gameStarted === "undefined" || !gameStarted) return;
        if (typeof isPaused !== "undefined" && isPaused) return;
        if (typeof gameState === "undefined" || gameState.gameEnded) { this.stop(); return; }
        if (gameMode !== "gnn") { this.stop(); return; }
        
        tf.tidy(() => {
          GnnAI.tick();
        });
        return;
      }
      return origTick();
    };
  }

  window.GnnAI = GnnAI;
  window.startGnnGame = startGnnGame;

  function createTrainingOverlay() {
    if (document.getElementById('gnn-training-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'gnn-training-overlay';
    overlay.style.cssText = `position: fixed; top: 10px; right: 10px; background: rgba(0, 0, 0, 0.8); color: #00ff99; font-family: monospace; font-size: 12px; padding: 12px; border-radius: 8px; border: 1px solid #00ff99; z-index: 9999; pointer-events: none;`;
    overlay.innerHTML = `
      <div style="font-weight:bold; margin-bottom:5px; color:#fff;">🧠 GNN AUTO-TRAINING</div>
      <div id="ov-episode">Episode: <span style="color:#fff">-</span></div>
      <div id="ov-winrate">Winrate: <span style="color:#fff">-</span></div>
      <div id="ov-action">Last: <span style="color:#87ceeb">-</span></div>
      <div style="margin-top:5px; border-top:1px solid #00ff99; padding-top:5px;">
        ⚔️ Army: <span id="ov-army" style="color:#ff6b6b">0</span> | 
        👷 Workers: <span id="ov-workers" style="color:#ffd93d">0</span>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  window.updateTrainingOverlay = function() {
    const overlay = document.getElementById('gnn-training-overlay');
    if (!overlay || !window.gameState || !window.GnnAI) return;
    
    const m = GnnAI.metrics();
    const stats = GnnAI.readStats();
    const gnnStats = stats.filter(s => s.mode === 'gnn');
    const wins = gnnStats.filter(s => s.result === 'win').length;
    const total = gnnStats.length || 1;
    const winrate = ((wins / total) * 100).toFixed(1);
    const workers = gameState.units.filter(u => u.owner === 'ai' && u.type === 'worker' && u.health > 0).length;

    document.getElementById('ov-episode').innerHTML = `Episode: <span style="color:#fff">#${total}</span>`;
    document.getElementById('ov-winrate').innerHTML = `Winrate: <span style="color:${winrate>=50?'#6bcb77':'#ff6b6b'}">${winrate}%</span>`;
    document.getElementById('ov-action').innerHTML = `Last: <span style="color:#87ceeb">${GnnAI.lastAction || 'init'}</span>`;
    document.getElementById('ov-army').innerText = m.aiArmy;
    document.getElementById('ov-workers').innerText = workers;
  };

  const _origRAF = window.requestAnimationFrame;
  window.requestAnimationFrame = function(callback) {
    return _origRAF(function(ts) {
      if (window.gameStarted && !gameState.gameEnded) window.updateTrainingOverlay();
      callback(ts);
    });
  };

  window.addEventListener("load", () => {
    if (typeof addMenuButton === "function") addMenuButton();
    if (typeof patchScheduler === "function") patchScheduler();
    
    console.log("[GnnAI] ✅ Система загружена и готова.");

    if (localStorage.getItem('gnn_auto_restart') === 'true') {
      console.log("[AutoStart] 🚀 Обнаружен режим авто-обучения. Ждем полной загрузки UI...");
      
      setTimeout(() => {
        console.log("[AutoStart] ⏱ Запуск GNN...");
        
        window.autoRestartEnabled = true;
        window.aiDifficulty = window.aiDifficulty || 0;
        
        createTrainingOverlay();
        
        if (typeof window.startGnnGame === "function") {
          window.startGnnGame();
        } else {
          console.error("[AutoStart] ❌ Ошибка: функция startGnnGame не найдена!");
        }
      }, 1500); 
    }
  });
})();