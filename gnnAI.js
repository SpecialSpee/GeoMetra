// ============================================================
// gnnAI.js — Истинно самообучающийся Графовый ИИ v6.0 (Pure RL)
// ============================================================

(function () {
  "use strict";

  if (window.GnnAI) {
    console.warn("[GnnAI] уже загружен");
    return;
  }

  const CFG = {
    MAX_NODES: 48,
    NODE_FEATURES: 32,
    GLOBAL_FEATURES: 20,
    HIDDEN: 128,
    LR: 0.001,
    DECISION_MS: 500,
    BUILD_QUEUE_MS: 500,
    ECO_MS: 1500,
    TRAIN_MS: 2000,
    SAVE_EVERY_BATCHES: 10,
    INTERACTION_RADIUS: 320,
    BASE_THREAT_RADIUS: 450,
    REPLAY_SIZE: 2000,
    BATCH_SIZE: 64,
    AUTO_ECONOMY: true,
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
    "defend", "buildInfra", "buildTurret", "hireWorker", "hireRepairman", 
    "hireFighter", "hireAssault", "hireElite", "attack_front", "attack_flank", "attack_feint", "expand", "idle"
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
    lastPhaseCheck: 0, // 🔥 ДОБАВЛЕНО: для фазовых наград
	  
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
    lastResourceTotal: 0,

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

      // 🔥 НОВОЕ: Явные флаги доступности технологий для ИИ
      const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks") ? 1 : 0;
      const hasBeacon = gameState.buildings.some(b => b.owner === "ai" && b.type === "beacon") ? 1 : 0;
      const canBuildBarracks2 = (hasBarracks && hasBeacon) ? 1 : 0; // Упрощенное условие для примера
      const canBuildBase3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2") ? 1 : 0;

      return [
        threat, baseHp, enemyNear, myArmy, enemyArmy, armyBalance, techLevel, 
        resTotal, warehouseCount, turretCount, timeNorm, enemyTurrets, enemyElites,
        buildingDiversity, resourceEfficiency, expansionProgress, defenseStrength,
        gameTimeMinutes, techStagnationPenalty, 
        canBuildBarracks2, // 🔥 Признак 20 (Заменяем 0 в конце)
        // canBuildBase3 (Если увеличишь GLOBAL_FEATURES до 21)
      ];
    },

    registerAction: function (action, graphState, intent, actionIndex) {
      if (!graphState || !graphState.X || !graphState.A) return;
      
      const replayEntry = {
        X: graphState.X, A: graphState.A,
        actionIndex: actionIndex !== undefined ? actionIndex : -1,
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

      // 🔥 НОВОЕ: Запоминаем, сколько врагов было у точки защиты в момент приказа
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

      // 🔥 ИНТРИНСИВНАЯ МОТИВАЦИЯ: Бонус за первые достижения
      if (this.episodeAchievements && intent) {
          let achievementBonus = 0;
          let achievementName = "";

          if (intent.type === "build") {
              if (intent.buildingType === "barracks" && !this.episodeAchievements.firstBarracks) {
                  this.episodeAchievements.firstBarracks = true;
                  achievementBonus = 15.0;
                  achievementName = "Первая Казарма";
              } else if (intent.buildingType === "base2" && !this.episodeAchievements.firstBase2) {
                  this.episodeAchievements.firstBase2 = true;
                  achievementBonus = 25.0;
                  achievementName = "Первая База 2";
              } else if (intent.buildingType === "barracks2" && !this.episodeAchievements.firstBarracks2) {
                  this.episodeAchievements.firstBarracks2 = true;
                  achievementBonus = 20.0;
                  achievementName = "Первая Казарма 2";
              } else if (intent.buildingType === "base3" && !this.episodeAchievements.firstBase3) {
                  this.episodeAchievements.firstBase3 = true;
                  achievementBonus = 35.0;
                  achievementName = "Первая База 3";
              }
          } else if (intent.type === "hire") {
              if (intent.unitType === "worker") {
                  const currentWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
                  if (currentWorkers === 0) { 
                      replayEntry.reward += 25.0;
                      console.log("[GnnAI] 🎉 ПЕРВЫЙ РАБОЧИЙ! Бонус: +25.0");
                  } else {
                      replayEntry.reward += 5.0;
                  }
              }

              if (intent.unitType === "assault" && !this.episodeAchievements.firstAssault) {
                  this.episodeAchievements.firstAssault = true;
                  achievementBonus = 20.0;
                  achievementName = "Первый Штурмовик";
              } else if (intent.unitType === "elite" && !this.episodeAchievements.firstElite) {
                  this.episodeAchievements.firstElite = true;
                  achievementBonus = 30.0;
                  achievementName = "Первая Элита";
              }
          }

          if (achievementBonus > 0) {
              replayEntry.reward += achievementBonus;
              console.log(`[GnnAI] 🏆 ДОСТИЖЕНИЕ: ${achievementName}! Бонус к награде: +${achievementBonus}`);
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
              this.replay.push({ X: currentState.X, A: currentState.A, actionIndex: AIDX.idle, reward: -5.0 });
              console.warn("[GnnAI] 💀 ЭКОНОМИЧЕСКИЙ ПАРАЛИЧ! Зданий:", economyBuildings, "Рабочих: 0");
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

        // === 1. ОЦЕНКА БОЕВЫХ ДЕЙСТВИЙ ===
        if (mission.intent.type === "attack") {
          // 🔥 ЧИСТЫЙ RL: Наказываем за потерю юнитов без нанесения урона (Суицидальные атаки)
          const aliveAttackers = (mission.intent.unitIds || []).reduce((sum, id) => {
            const u = gameState.units.find(x => x.id === id);
            return sum + (u && u.health > 0 ? 1 : 0);
          }, 0);
          const lostAttackers = mission.intent.unitIds.length - aliveAttackers;
          
          if (lostAttackers > 0) {
             const target = gameState.units.find(u => u.id === mission.snapshot.targetId) || gameState.buildings.find(b => b.id === mission.snapshot.targetId);
             const damageDealt = target ? Math.max(0, mission.snapshot.targetStartHP - target.health) : 0;
             
             if (damageDealt < (lostAttackers * 15)) {
                 rewardDelta -= (lostAttackers * 10.0);
                 reason = "PYRRHIC_DEFEAT_SUICIDE_ATTACK";
                 isResolved = true;
             }
          }

          const target = gameState.units.find(u => u.id === mission.snapshot.targetId) || gameState.buildings.find(b => b.id === mission.snapshot.targetId);
          const currentTargetHP = target ? target.health : 0;
          const damageDealt = Math.max(0, mission.snapshot.targetStartHP - currentTargetHP);
          const lostAttackersCalc = mission.intent.unitIds.length - aliveAttackers;

          if (!target || currentTargetHP <= 0) {
            if (target && target.owner === "player") {
              const targetValue = this.getUnitValue(target.type) || 50;
              const lostValue = lostAttackersCalc * 15; 
              if (target.type === "base" || target.type === "base2" || target.type === "base3") {
                rewardDelta = 100.0;
                reason = "ENEMY_BASE_DESTROYED";
              } else if (targetValue > lostValue) {
                rewardDelta = 10.0 + (damageDealt * 0.2);
                reason = "favorable_trade_outcome";
              } else {
                rewardDelta = 2.0;
                reason = "pyrrhic_victory_outcome";
              }
            }
            isResolved = true;
          } else if (aliveAttackers === 0 && mission.intent.unitIds.length > 0) {
            rewardDelta = -15.0;
            reason = "useless_sacrifice_OUTCOME";
            isResolved = true;
          } else {
            const elapsed = performance.now() - mission.snapshot.time;
            const dps = damageDealt / (elapsed / 1000);
            if (dps > 20) {
              rewardDelta = dps * 0.05;
              reason = "effective_dps_PROGRESS";
            } else if (elapsed > 10000 && damageDealt === 0) {
              rewardDelta = -5.0;
              reason = "attack_stalled_penalty";
              isResolved = true;
            }
          }
        }

        // === 2. ОЦЕНКА ЗАЩИТЫ (ИСПРАВЛЕННАЯ) ===
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

          // 1. Успешная защита: враги были, теперь их нет, и наши юниты ВЫЖИЛИ
          if (enemiesAtStart > 0 && enemiesNearAnchorNow === 0 && aliveDefenders > 0) {
            rewardDelta = 6.0;
            reason = "successful_defense_OUTCOME";
            isResolved = true;
          }
          // 2. Бесполезная трата времени: врагов не было и нет
          else if (enemiesAtStart === 0 && enemiesNearAnchorNow === 0) {
            rewardDelta = -3.0;
            reason = "defending_nothing_penalty";
            isResolved = true;
          }
          // 3. Провал: все отправленные защитники погибли
          else if (totalDefendersAtStart > 0 && aliveDefenders === 0) {
            rewardDelta = -6.0;
            reason = "all_defenders_lost_OUTCOME";
            isResolved = true;
          }
          // 4. Защита продолжается: враги все еще здесь, но мы держимся (не завершаем миссию, пусть висит)
          else if (enemiesNearAnchorNow > 0 && aliveDefenders > 0) {
            rewardDelta = 0.5; // Небольшой бонус за удержание позиции
            // isResolved = true; <--- НЕ СТАВИМ, пусть миссия оценивается снова через 5 сек
          }
        }

        // === 4. ОЦЕНКА НАЙМА (ИСПРАВЛЕННАЯ) ===
        else if (mission.intent.type === "hire") {
          // Проверяем, действительно ли армия выросла (или это рабочий/ремонтник)
          if (this.metrics().aiArmy > mission.snapshot.aiArmy || mission.intent.unitType === "worker" || mission.intent.unitType === "repairman") {
            const type = mission.intent.unitType;
            let hireReward = 0;
            
            // 🔥 ИСПРАВЛЕНИЕ: Бонус за наем бойца только при РЕАЛЬНОЙ угрозе (threat >= 5), а не просто > 0
            if (type === "fighter" && this.strategicMemory.threatLevel >= 5) {
                hireReward = 2.0; // Снизили с 3.0, чтобы не спамили ради очков
                reason = "heroic_recruitment_under_high_threat";
            } else if (type === "fighter") {
                hireReward = 1.0; // Базовая награда за бойца
                reason = "fighter_hired";
            } else if (type === "worker") {
                hireReward = 1.5;
            } else if (type === "repairman") {
                hireReward = 1.0;
            } else if (type === "assault") {
                hireReward = 3.0;
            } else if (type === "elite") {
                hireReward = 5.0;
            }
            
            rewardDelta = hireReward;
            reason = reason || `unit_hired_${type}_reward`;
            isResolved = true;
          } else {
            // Если армия не выросла (например, юнит умер сразу или очередь полная), штраф за потраченное время
            const elapsed = performance.now() - mission.snapshot.time;
            if (elapsed > 10000) {
              rewardDelta = -1.0;
              reason = "hire_failed_or_timeout_penalty";
              isResolved = true;
            }
          }
        }
        
        // === 5. ОЦЕНКА БЕЗДЕЙСТВИЯ ===
        else if (mission.intent.type === "idle") {
          if (m.resTotal > 200) {
            rewardDelta = -1.0;
            reason = "idle_with_resources_penalty";
          } else {
            rewardDelta = -0.2;
            reason = "waiting";
          }
          isResolved = true;
        }

        // ПРИМЕНЕНИЕ ДЕЛЬТЫ
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

    // 🔥 МАСТЕР-ПЛАН: Фазовые награды (Pure RL, NO CRUTCHES)
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

      // ФАЗА 1: ФУНДАМЕНТ (0 - 1.5 мин)
      if (gameTimeMin < 1.5) {
        if (m.aiWarehouses > 0 && workers > 0) {
          phaseReward += 8.0;
          reasons.push("PHASE1_ECONOMY_ACTIVE_BONUS");
        }
        if (barracks && workers === 0) {
          phaseReward -= 12.0;
          reasons.push("PHASE1_MILITARY_WITHOUT_ECONOMY_PENALTY");
        }
      }
      // ФАЗА 2: ПЕРВЫЙ КОНТАКТ (1.5 - 3.0 мин)
      else if (gameTimeMin < 3.0) {
        if (armySize >= 3) {
          phaseReward += 6.0;
          reasons.push("PHASE2_MINIMUM_ARMY_BONUS");
        }
        if (armySize === 0 && gameTimeMin > 2.5) {
          phaseReward -= 10.0;
          reasons.push("PHASE2_ZERO_ARMY_PENALTY");
        }
      }
      // ФАЗА 3: ТЕХНОЛОГИИ (3.0 - 6.0 мин)
      else if (gameTimeMin < 6.0) {
        const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2");
        if (hasBase2) {
          phaseReward += 12.0;
          reasons.push("PHASE3_TIER2_ACHIEVEMENT_BONUS");
        }
        if (!hasBase2) {
          const minutesLate = gameTimeMin - 3.0;
          phaseReward -= (5.0 * minutesLate); 
          reasons.push(`PHASE3_TIER1_STAGNATION_PENALTY (-${(5.0 * minutesLate).toFixed(1)})`);
        }
      }
      // ФАЗА 4: ПОЗДНЯЯ ИГРА (6.0+ мин)
      else {
        const eliteCount = gameState.units.filter(u => u.owner === "ai" && u.type === "elite").length;
        const assaultCount = gameState.units.filter(u => u.owner === "ai" && u.type === "assault").length;
        
        if (assaultCount > 0 || eliteCount > 0) {
          phaseReward += 10.0;
          reasons.push("PHASE4_ADVANCED_UNITS_BONUS");
        }

        if (armySize > 10) {
          const fighterCount = gameState.units.filter(u => u.owner === "ai" && u.type === "fighter").length;
          if (fighterCount / armySize > 0.9) {
            phaseReward -= 8.0;
            reasons.push("PHASE4_INEFFICIENT_ARMY_COMPOSITION_PENALTY");
          }
        }
      }

      if (phaseReward !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A: currentState.A, actionIndex: AIDX.idle, reward: phaseReward });
          if (phaseReward > 0) {
            console.log(`[GnnAI Phase] 💰 Фазовая награда: +${phaseReward.toFixed(1)} (${reasons.join(', ')})`);
          } else {
            console.warn(`[GnnAI Phase] ⚠️ Фазовый штраф: ${phaseReward.toFixed(1)} (${reasons.join(', ')})`);
          }
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

      if (m.resTotal > 300 && m.aiArmy === this.lastArmySize && m.aiBuildings === this.lastBuildingCount) {
        penalty -= 2.0;
        reasons.push("resource_hoarding_without_investment");
      }
      if (m.aiTurrets >= 4 && m.aiArmy < 3 && gameTimeMin > 4) {
        penalty -= 3.0;
        reasons.push("turtle_strategy_without_army");
      }
      if (gameTimeMin > 5 && m.techLevel === 1) {
        penalty -= 1.5;
        reasons.push("tech_stagnation_tier1");
      }
      if (m.aiArmy > this.lastArmySize && m.resTotal < 150) {
        penalty += 2.0;
        reasons.push("healthy_economy_to_military_conversion");
      }
      if (m.resTotal > 2000 && m.aiArmy < 10) {
        penalty -= 5.0;
        reasons.push("hoarding_resources_without_army");
      }

      if (penalty !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A: currentState.A, actionIndex: AIDX.idle, reward: penalty });
          if (penalty < 0) console.warn(`[GnnAI] ⚠️ Обнаружен тупик: ${penalty} (${reasons.join(', ')})`);
        }
      }

      this.lastArmySize = m.aiArmy;
      this.lastBuildingCount = m.aiBuildings;
      this.lastResourceTotal = m.resTotal;
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
          console.error(`[GnnAI] 🚨 ПАНИКА! Угроза: ${this.strategicMemory.threatLevel}, Армия: 0. Штраф -15.0!`);
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

      const units = gameState.units.filter(u => u.owner === "ai" && u.health > 0);
      const fighterCount = units.filter(u => u.type === "fighter").length;
      const assaultCount = units.filter(u => u.type === "assault").length;
      const eliteCount = units.filter(u => u.type === "elite").length;
      const totalArmy = units.length;
      
      if (totalArmy > 15 && gameTimeMin > 5) {
          const fighterRatio = fighterCount / totalArmy;
          if (fighterRatio > 0.8) {
              penalty -= 8.0;
              reasons.push("inefficient_army_composition_80_percent_fighters");
          }
          if (fighterRatio > 0.9) {
              penalty -= 12.0;
              reasons.push("terrible_army_composition_90_percent_fighters");
          }
      }

      const uniqueTypes = (fighterCount > 0 ? 1 : 0) + (assaultCount > 0 ? 1 : 0) + (eliteCount > 0 ? 1 : 0);
      if (uniqueTypes >= 2 && gameTimeMin > 6) {
          penalty += 5.0;
          reasons.push("diverse_army_bonus");
      }
      if (uniqueTypes === 3 && gameTimeMin > 8) {
          penalty += 10.0;
          reasons.push("full_composition_bonus");
      }

      const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
      const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2" && b.active);
      const hasBase3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base3" && b.active);

      if (gameTimeMin > 4 && !hasBarracks) {
          penalty -= 3.0;
          reasons.push("no_barracks_by_4min_CRITICAL");
      }
      if (gameTimeMin > 8 && !hasBase2) {
          penalty -= 8.0;
          reasons.push("tech_stagnation_tier1_CRITICAL");
      }
      if (gameTimeMin > 12 && !hasBase3) {
        penalty -= 4.0;
        reasons.push("no_base3_by_12min");
      }

      const turretCount = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.active).length;
      if (turretCount > 5 && m.aiArmy < 3 && gameTimeMin > 5) {
        penalty -= 2.0;
        reasons.push("turrets_without_army");
      }

      const beaconCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.active).length;
      if (beaconCount > 2 && !hasBase2 && gameTimeMin > 5) {
        penalty -= 3.0;
        reasons.push("beacon_spam_without_base2");
      }

      if (hasBarracks && hasBase2 && m.aiArmy > 5 && gameTimeMin > 5) {
        penalty += 2.0;
        reasons.push("balanced_development");
      }

      if (!hasBarracks && gameTimeMin > 3) {
          const minutesLate = gameTimeMin - 3;
          penalty -= 3.0 * minutesLate;
          reasons.push(`no_barracks_${minutesLate.toFixed(1)}min_late`);
      }
      
      if (!hasBase2 && gameTimeMin > 6) {
          const minutesLate = gameTimeMin - 6;
          penalty -= 5.0 * minutesLate;
          reasons.push(`no_base2_${minutesLate.toFixed(1)}min_late`);
      }
													 
      if (penalty !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({ X: currentState.X, A: currentState.A, actionIndex: AIDX.idle, reward: penalty });
          if (penalty > 0) {
            console.log(`[GnnAI] 💰 Награда за прогресс: +${penalty} (${reasons.join(', ')})`);
          } else {
            console.warn(`[GnnAI] ⚠️ Штраф за регресс: ${penalty} (${reasons.join(', ')})`);
          }
        }
      }
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

      const self = this;
      this.model = {
        forwardBatch: (x, adj) => {
          return tf.tidy(() => {
            const B = x.shape[0];
            const N = CFG.MAX_NODES;
            
            const xExpanded = x.tile([1, 1, N]).reshape([B, N, N, F]);
            const xTransposed = x.expandDims(2).tile([1, 1, N, 1]);
            const pairFeat = tf.concat([xExpanded, xTransposed], 3).reshape([B * N * N, F * 2]);
            const attnLogits = tf.matMul(pairFeat, W_attn).reshape([B, N, N]);
            const attnWeights = tf.softmax(attnLogits, 2);
            
            const weightedAdj = tf.mul(adj, attnWeights);
            const agg1 = tf.matMul(weightedAdj, x);
            const h1 = tf.relu(tf.matMul(agg1.reshape([B * N, F]), W1).add(b1).reshape([B, N, H]));
            
            const agg2 = tf.matMul(weightedAdj, h1);
            const h2 = tf.relu(tf.matMul(agg2.reshape([B * N, H]), W2).add(b2).reshape([B, N, H]));
            
            const mask = x.slice([0, 0, 0], [B, N, 1]);
            const pooled = h2.mul(mask).sum(1).div(tf.maximum(mask.sum(1), 1));
            
            const globalBatch = tf.tensor2d(Array(B).fill(0).map(() => self.getGlobalFeatures()));
            const combined = tf.concat([pooled, globalBatch], 1);
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
      console.log(`[GnnAI] ✅ Модель v6.0 (Pure RL) готова. Backend: ${tf.getBackend()}`);
    },

    predict: function (state) {
      if (!this.model) {
        console.warn("[GnnAI] predict: model ещё не инициализирован");
        return { logits: tf.tensor2d([new Array(G_ACTIONS.length).fill(0)]), value: tf.tensor2d([[0]]) };
      }
      return tf.tidy(() => {
        const x = tf.tensor2d(state.X).expandDims(0);
        const a = tf.tensor2d(state.A).expandDims(0);
        return this.model.forwardBatch(x, a);
      });
    },

    tick: async function () {
      if (!gameStarted || gameState.gameEnded || gameMode !== "gnn") return;
      if (!this.initialized) await this.init();

      const now = performance.now();
      await this.checkEnd();
      this.assessThreats();
      
      this.evaluatePhaseRewards(now); // 🔥 СЕРДЦЕ ЧИСТОГО RL
      this.checkTechStagnation(now);
      this.evaluateStagnation(now);
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

      const { logits } = this.predict(state);
      const logitsData = Array.from(logits.dataSync());
      const mask = this.validActionMask();
      const actionIndex = this.sampleMasked(logitsData, mask, 1.5);
      const action = G_ACTIONS[actionIndex];

      const metrics = this.metrics();
      const executed = this.execute(action, actionIndex, state);

      this.pending.push({ 
        time: performance.now(), state, action, actionIndex, 
        executed: !!executed, 
        executedType: typeof executed === 'string' ? executed : null,
        before: metrics 
      });
      if (this.pending.length > 30) this.pending.shift();

      this.lastState = state;
      this.lastAction = action;

      console.log("[GnnAI]", action, executed ? "✅" : "⚠️", {
        army: metrics.aiArmy, enemyNear: metrics.enemyNear, threat: this.strategicMemory.threatLevel
      });
    },

    evaluatePending: function (now) {
      if (!this.pending.length) return;
      const current = this.metrics();
      const keep = [];

      for (const p of this.pending) {
        let delay = 4000;
        if (["buildInfra", "buildTurret", "expand"].includes(p.action)) delay = 12000;
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
          this.replay.push({ X: p.state.X, A: p.state.A, actionIndex: p.actionIndex, reward });
        }
      }
      this.pending = keep;
    },

    reward: function (p, after) {
      if (after.baseHp <= 0) return -100.0;
      if (!after.playerAlive) return 100.0;
      return (after.baseHp - p.before.baseHp) * 10.0;
    },

    trainBatch: async function () {
      if (this.training || this.replay.length < CFG.BATCH_SIZE) return;
      this.training = true;

      const batch = [];
      for (let i = 0; i < CFG.BATCH_SIZE; i++) {
        const sample = this.replay.getRandom();
        if (sample && sample.X && sample.A) batch.push(sample);
      }
      if (batch.length === 0) { this.training = false; return; }

      const B = batch.length;
      const xs = tf.tensor3d(batch.map(b => b.X), [B, CFG.MAX_NODES, CFG.NODE_FEATURES]);
      const as = tf.tensor3d(batch.map(b => b.A), [B, CFG.MAX_NODES, CFG.MAX_NODES]);
      const act = tf.tensor1d(batch.map(b => b.actionIndex), "int32");
      const rew = tf.tensor1d(batch.map(b => b.reward), "float32");
      let loss = null;

      try {
        loss = this.optimizer.minimize(() => {
          const { logits, value } = this.model.forwardBatch(xs, as);
          const logProbs = tf.logSoftmax(logits);
          const oneHot = tf.oneHot(act, G_ACTIONS.length);
          const pickedLogProb = logProbs.mul(oneHot).sum(1);
          
          const rawAdvantage = rew.sub(value.squeeze());
          const clippedAdvantage = tf.clipByValue(rawAdvantage, -10.0, 10.0); 
          
          const actorLoss = pickedLogProb.mul(clippedAdvantage).mul(-1).mean();
          const criticLoss = tf.losses.meanSquaredError(rew, value.squeeze());
          const probs = tf.softmax(logits);
          const entropy = probs.mul(logProbs).mul(-1).sum(1).mean();
          
          return actorLoss.add(criticLoss.mul(0.5)).sub(entropy.mul(0.03));
        }, true, this.vars);

        const lv = await loss.data();
        this.trainBatches++;

        if (this.trainBatches % 10 === 0) {
          console.log("[GnnAI train]", { batch: this.trainBatches, loss: Number(lv[0].toFixed(5)), replay: this.replay.length, backend: tf.getBackend() });
        }
        if (this.trainBatches % CFG.SAVE_EVERY_BATCHES === 0) {
          await this.saveWeights();
        }
      } catch (e) {
        console.error("[GnnAI] train error", e);
      } finally {
        if (loss) loss.dispose();
        xs.dispose(); as.dispose(); act.dispose(); rew.dispose();
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
        raw.push({ obj: null, type: "pad", owner: "none", x: aiBase.x, y: aiBase.y, hp: 0, valid: 0 });
      }

      const X = raw.map(n => this.nodeFeatures(n));
      const A = [];
      for (let i = 0; i < CFG.MAX_NODES; i++) {
        const row = [];
        const ni = raw[i];
        for (let j = 0; j < CFG.MAX_NODES; j++) {
          const nj = raw[j];
          if (!ni.valid || !nj.valid) { row.push(0); continue; }
          if (i === j) { row.push(1); continue; }
          const d = Math.hypot(ni.x - nj.x, ni.y - nj.y);
          row.push(d <= CFG.INTERACTION_RADIUS ? Math.exp(-d / CFG.INTERACTION_RADIUS) : 0);
        }
        const sum = row.reduce((a, b) => a + b, 0) || 1;
        A.push(row.map(v => v / sum));
      }
      return { X, A, nodes: raw };
    },

    nodeFeatures: function (n) {
      const t = n.type || "";
      const isBuilding = typeof Building !== "undefined" && n.obj instanceof Building;
      const isResource = ["gold", "silicon", "plasma"].includes(t);
      const isCombat = ["fighter", "assault", "elite"].includes(t);
      const isTurret = typeof t === "string" && t.startsWith("turret");
      
      const wW = typeof worldWidth !== 'undefined' ? worldWidth : 2000;
      const wH = typeof worldHeight !== 'undefined' ? worldHeight : 2000;
      const relX = Math.max(-1, Math.min(1, (n.x - aiBase.x) / Math.max(1, wW * 0.5)));
      const relY = Math.max(-1, Math.min(1, (n.y - aiBase.y) / Math.max(1, wH * 0.5)));
      const dist = Math.max(0, Math.min(1, Math.hypot(n.x - aiBase.x, n.y - aiBase.y) / 1600));
      const threat = n.owner === "player" ? (THREAT_ASSESSMENT[t] || 0) / 7 : 0;
      
      const isActive = n.obj && n.obj.active ? 1 : 0;
      const isUnderConstruction = n.obj && n.obj.builtAt && !n.obj.active ? 1 : 0;
      const isKeyBuilding = ["base", "base2", "base3", "barracks", "barracks2", "barracks3", "warehouse", "beacon"].includes(t) ? 1 : 0;
      const isMilitary = isCombat || isTurret ? 1 : 0;
      const isEconomic = t === "warehouse" || t === "repairWorkshop" ? 1 : 0;
      const isExpansion = t === "base2" || t === "base3" || t === "beacon" ? 1 : 0;
      const techLevel = t === "base3" || t === "barracks3" || t === "turret3" ? 3 : (t === "base2" || t === "barracks2" || t === "turret2" ? 2 : 1);

      // 🔥 НОВОЕ 1: Находится ли этот объект под прямой атакой врага (радиус 150px)?
      let isUnderAttack = 0;
      if (n.obj && n.obj.owner === "ai" && n.obj.health > 0) {
        const enemiesNearby = gameState.units.some(u => u.owner === "player" && u.health > 0 && Math.hypot(u.x - n.obj.x, u.y - n.obj.y) < 150);
        if (enemiesNearby) isUnderAttack = 1;
      }

      // 🔥 НОВОЕ 2: Свободен ли юнит? (Нет очереди команд)
      let isIdle = 0;
      if (n.obj && n.obj.owner === "ai" && isCombat) {
        if (!n.obj.commandQueue || n.obj.commandQueue.length === 0) {
          isIdle = 1;
        }
      }

      return [
        n.valid ? 1 : 0, n.owner === "ai" ? 1 : 0, n.owner === "player" ? 1 : 0, n.hp || 0,
        relX, relY, dist, isCombat ? 1 : 0, isBuilding ? 1 : 0,
        t === "worker" ? 1 : 0, t === "fighter" ? 1 : 0, t === "assault" ? 1 : 0, t === "elite" ? 1 : 0,
        t.startsWith("base") ? 1 : 0, isTurret ? 1 : 0, t === "warehouse" ? 1 : 0, t === "beacon" ? 1 : 0, isResource ? 1 : 0,
        isBuilding && (t === "warehouse" || t === "repairWorkshop") ? 1 : 0, t === "repairWorkshop" ? 1 : 0,
        threat, n.obj?.range ? Math.min(1, n.obj.range / 500) : 0, n.obj?.fireRate ? Math.min(1, 1000 / n.obj.fireRate) : 0, 
        this.strategicMemory.threatLevel / 30,
        isActive, isUnderConstruction, isKeyBuilding, isMilitary, isEconomic, isExpansion, techLevel / 3,
        isUnderAttack, // 🔥 Признак 31
        isIdle         // 🔥 Признак 32 (Заменил дублирующийся isBuilding && !warehouse)
      ];
    },

    validActionMask: function () {
      const mask = new Array(G_ACTIONS.length).fill(0);
      const u = this.getUnlocks();
      const res = gameState.aiResources;
      
      const can = cost => {
        if (!res) return false;
        return (res.gold || 0) >= (cost.gold || 0) && (res.silicon || 0) >= (cost.silicon || 0) && (res.plasma || 0) >= (cost.plasma || 0);
      };

      mask[AIDX.idle] = 1;
      mask[AIDX.buildInfra] = 1; 

      if (u.tier2_basicMilitary) {
        mask[AIDX.hireFighter] = 1;
        let currentTurrets = 0;
        gameState.buildings.forEach(b => { if (b.owner === "ai" && b.type?.startsWith("turret")) currentTurrets++; });
        window.buildQueue.forEach(q => { if (q.type?.startsWith("turret")) currentTurrets++; });
        const beaconCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.active).length;
        const maxAllowedTurrets = (beaconCount * 3) + 1;
        if (currentTurrets < maxAllowedTurrets && can(TURRET_COST)) mask[AIDX.buildTurret] = 1;
      }

      if (u.tier3_armyControl) {
        mask[AIDX.defend] = 1; mask[AIDX.attack_front] = 1; mask[AIDX.attack_flank] = 1; mask[AIDX.attack_feint] = 1;
      }
      if (u.tier4_advanced) { mask[AIDX.hireAssault] = 1; mask[AIDX.expand] = 1; }
      if (u.tier5_lateGame) { mask[AIDX.hireElite] = 1; }

      const totalRes = (res?.gold || 0) + (res?.silicon || 0) + (res?.plasma || 0);
      if (totalRes < 30) {
        if (!can(FIGHTER_COST)) mask[AIDX.hireFighter] = 0;
        if (!can(ASSAULT_COST)) mask[AIDX.hireAssault] = 0;
        if (!can(ELITE_COST)) mask[AIDX.hireElite] = 0;
      }

      if (!can(FIGHTER_COST)) mask[AIDX.hireFighter] = 0;
      if (!can(ASSAULT_COST)) mask[AIDX.hireAssault] = 0;
      if (!can(ELITE_COST)) mask[AIDX.hireElite] = 0;
      if (!can(TURRET_COST)) mask[AIDX.buildTurret] = 0;
						
      const hasWarehouseWithSpace = gameState.buildings.some(b => b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5));
      if (hasWarehouseWithSpace && can(WORKER_COST)) mask[AIDX.hireWorker] = 1;

      const hasWorkshopWithSpace = gameState.buildings.some(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active && (b.repairman || 0) < (b.capacity || 3));
      if (hasWorkshopWithSpace && can(REPAIRMAN_COST)) mask[AIDX.hireRepairman] = 1;						

      if (mask.every(v => v === 0)) mask[AIDX.idle] = 1;
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

    buildInfra: function () {
      const res = gameState.aiResources;
      const canAfford = (cost) => {
        if (!res) return false;
        return (res.gold || 0) >= (cost.gold || 0) && 
               (res.silicon || 0) >= (cost.silicon || 0) && 
               (res.plasma || 0) >= (cost.plasma || 0);
      };

      // 1. Считаем, что УЖЕ построено (для проверки иерархии)
      const warehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse").length;
      const workshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop").length;
      const barracks = gameState.buildings.filter(b => b.owner === "ai" && b.type === "barracks").length;
      const beacons = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon").length;
      const base2 = gameState.buildings.filter(b => b.owner === "ai" && b.type === "base2").length;
      const barracks2 = gameState.buildings.filter(b => b.owner === "ai" && b.type === "barracks2").length;
      const base3 = gameState.buildings.filter(b => b.owner === "ai" && b.type === "base3").length;
      const barracks3 = gameState.buildings.filter(b => b.owner === "ai" && b.type === "barracks3").length;

      const availableBuildings = [];

      //  УРОВЕНЬ 1: База (Всегда доступно)
      if (warehouses === 0 && canAfford(WAREHOUSE_COST)) availableBuildings.push("warehouse");
      if (warehouses >= 1 && workshops === 0 && canAfford(REPAIR_WORKSHOP_COST)) availableBuildings.push("repairWorkshop");

      //  УРОВЕНЬ 2: Первая военная постройка (Требует Склад И Мастерскую!)
      if (warehouses >= 1 && workshops >= 1 && barracks === 0 && canAfford(BARRACKS_COST)) {
        availableBuildings.push("barracks");
      }
      if (barracks >= 1 && canAfford(TURRET_COST)) {
        availableBuildings.push("turret");
      }

      // 🟠 УРОВЕНЬ 3: Расширение и защита (Требует Казарму)
      if (barracks >= 1 && beacons === 0 && canAfford(BEACON_COST)) {
        availableBuildings.push("beacon");
      }

      // 🔴 УРОВЕНЬ 4: Вторая база (Требует Маяк)
      if (beacons >= 1 && base2 === 0 && canAfford(BASE2_COST)) {
        availableBuildings.push("base2");
      }

      // 🟣 УРОВЕНЬ 5: Продвинутая военка (Требует Базу 2)
      if (base2 >= 1 && barracks2 === 0 && canAfford(BARRACKS2_COST)) {
        availableBuildings.push("barracks2");
      }
      if (barracks2 >= 1 && canAfford(TURRET2_COST)) {
        availableBuildings.push("turret2");
      }

      // ⚫ УРОВЕНЬ 6: Высший тир (Требует Базу 2 для базы 3, и Базу 3 для казармы 3)
      if (base2 >= 1 && base3 === 0 && canAfford(BASE3_COST)) {
        availableBuildings.push("base3");
      }
      if (base3 >= 1 && barracks3 === 0 && canAfford(BARRACKS3_COST)) {
        availableBuildings.push("barracks3");
      }
      if (barracks3 >= 1 && canAfford(TURRET3_COST)) {
        availableBuildings.push("turret3");
      }

      if (availableBuildings.length === 0) return false;

      let typeToBuild;
      const m = this.metrics();
      const gameTimeMin = performance.now() / 60000;
      
      if (availableBuildings.includes("barracks")) {
          if (this.strategicMemory.threatLevel > 0 || gameTimeMin > 1.5) {
              typeToBuild = Math.random() < 0.85 ? "barracks" : availableBuildings[Math.floor(Math.random() * availableBuildings.length)];
          } else {
              typeToBuild = Math.random() < 0.5 ? "barracks" : availableBuildings[Math.floor(Math.random() * availableBuildings.length)];
          }
      } else {
          typeToBuild = availableBuildings[Math.floor(Math.random() * availableBuildings.length)];
      }
      
      const pos = this.findBuildPos(aiBase, typeToBuild, 70, 240);
      return pos ? scheduleAIBuilding(typeToBuild, pos.x, pos.y, 0) : false;
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

        if (action === "attack_front" || action === "attack_flank" || action === "attack_feint") {
          const percentages = { attack_front: 0.8, attack_flank: 0.6, attack_feint: 0.2 };
          const offsets = { attack_front: 0, attack_flank: 300, attack_feint: 0 };
          const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter", "assault", "elite"].includes(u.type) && u.health > 0 && (!u.commandQueue || u.commandQueue.length === 0));
          if (freeUnits.length === 0) return false;

          const targets = [...gameState.units.filter(u => u.owner === "player" && u.health > 0), ...gameState.buildings.filter(b => b.owner === "player" && b.health > 0)];
          if (targets.length === 0) return false;

          const mainTarget = targets.reduce((best, o) => Math.hypot(o.x - aiBase.x, o.y - aiBase.y) < Math.hypot(best.x - aiBase.x, best.y - aiBase.y) ? o : best);
          const attackersCount = Math.ceil(freeUnits.length * percentages[action]);
          const attackers = freeUnits.slice(0, attackersCount);
          const attackerIds = attackers.map(u => u.id);

          attackers.forEach(u => {
            u.defending = false;
            let tx = mainTarget.x, ty = mainTarget.y;
            if (offsets[action] > 0) {
              tx += (Math.random() > 0.5 ? 1 : -1) * offsets[action];
              ty += (Math.random() > 0.5 ? 1 : -1) * offsets[action];
            }
            u.commandQueue = [{ type: "move", x: tx, y: ty }, { type: "attack", target: mainTarget }];
            if (typeof processCommandQueue === "function") processCommandQueue(u);
          });

          this.registerAction(action, state, { type: "attack", targetId: mainTarget.id, initialHp: mainTarget.health, units: attackersCount, unitIds: attackerIds }, actionIndex);
          return true;
        }

        if (action === "buildInfra") {
          const success = this.buildInfra();
          if (success) {
             this.registerAction(action, state, { type: "build", buildingType: success }, actionIndex);
             return true;
          } else {
             // 🔥 НЕЙТРАЛЬНО: Ошибочный тычок = 0.0. Никакой боли!
             this.replay.push({ X: state.X, A: state.A, actionIndex: actionIndex, reward: 0.0 });
             return false;
          }
        }
        
        if (action === "buildTurret") {
          const pos = this.findBuildPos(this.threatAnchor() || aiBase, "turret");
          if (pos) {
            this.registerAction(action, state, { type: "build", buildingType: "turret" }, actionIndex);
            return !!scheduleAIBuilding("turret", pos.x, pos.y, 0);
          }
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
          
          if (this.enqueueUnit(uType, bType, cost)) {
            this.registerAction(action, state, { type: "hire", unitType: uType }, actionIndex);
            return true;
          }
          // 🔥 НЕЙТРАЛЬНО: Не хватило денег или нет здания? Это 0.0
          this.replay.push({ X: state.X, A: state.A, actionIndex: actionIndex, reward: 0.0 });
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
      if (typeof aiHireWorker !== "function") return;
      for (const b of gameState.buildings) {
        if (b.owner !== "ai" || !b.active) continue;
        if (b.type === "warehouse") {
          let guard = 0;
          while ((b.workers || 0) < (b.maxDeliveryWorkers || 5) && guard++ < 10 && canSpendResources(WORKER_COST, "ai")) {
            aiHireWorker(b);
          }
        }
        if (b.type === "repairWorkshop" && typeof aiHireRepairMan === "function") {
          let guard = 0;
          const maxRepairmen = b.capacity || 3;
          while ((b.repairman || 0) < maxRepairmen && guard++ < 5 && canSpendResources(REPAIRMAN_COST, "ai")) {
            aiHireRepairMan(b);
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

    findBuildPos: function (anchor, type, minR = 80, maxR = 350) { // 🔥 Увеличили радиус поиска
      if (!anchor) anchor = aiBase;
      
      // Попытка 1: Случайный поиск в кольце (60 попыток)
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
          const br = { left: b.x - b.width / 2 - 10, top: b.y - b.height / 2 - 10, right: b.x + b.width / 2 + 10, bottom: b.y + b.height / 2 + 10 }; // 🔥 Увеличили отступ до 10
          if (typeof rectsOverlap === "function" && rectsOverlap(rect, br)) { bad = true; break; }
        }
        if (!bad) return { x, y };
      }

      // Попытка 2: Если рандом не сработал, ищем по 4 сторонам света жестко
      console.warn(`[GnnAI] ⚠️ Рандом не нашел место для ${type}, использую жесткий поиск`);
      const offsets = [
        { x: anchor.x + 150, y: anchor.y },      // Справа
        { x: anchor.x - 150, y: anchor.y },      // Слева
        { x: anchor.x, y: anchor.y + 150 },      // Снизу
        { x: anchor.x, y: anchor.y - 150 },      // Сверху
        { x: anchor.x + 150, y: anchor.y + 150 } // По диагонали
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

      // Попытка 3: Полный провал. Возвращаем хоть что-то, пусть игра сама ругается, но ИИ попытается
      console.error(`[GnnAI] ❌ КРИТИЧЕСКАЯ ОШИБКА: Невозможно найти место для ${type}! Возвращаю координаты базы.`);
      return { x: anchor.x + 200, y: anchor.y + 200 };
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
      const hasBuilding = (type) => gameState.buildings.some(b => b.owner === "ai" && b.type === type);
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
        console.log("[GnnAI] 💾 Игра завершена (База уничтожена). Сохранение весов...");
        await this.saveWeights();

        if (!aiBaseAlive) {
          this.finishEpisode("loss");
          if (typeof showVictoryScreen === "function") setTimeout(() => showVictoryScreen("GNN ИИ проиграл (База уничтожена)."), 1000);
        } else {
          this.finishEpisode("win");
          if (typeof showVictoryScreen === "function") setTimeout(() => showVictoryScreen("GNN ИИ победил!"), 1000);
        }
      }
    },

    saveWeights: async function () {
      if (!this.vars.length) return;
      try {
        const data = this.vars.map(v => ({ shape: v.shape, values: Array.from(v.dataSync()) }));
        await WeightDB.save(CFG.STORAGE_KEY, { version: 6, batches: this.trainBatches, data, backend: tf.getBackend() });
        console.log("[GnnAI] 💾 Веса успешно сохранены в IndexedDB");
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
        e.detail === "base2" || e.detail === "base3" ||
        e.detail === "fighter" || e.detail === "assault" || e.detail === "elite" ||
        e.action === "attack_front" || e.action === "attack_flank" || e.action === "attack_feint"
      );
      
      if (keyEvents.length > 0) {
        console.log("🏗️ Ключевые события (постройки, найм, атаки):");
        console.table(keyEvents, ["time", "action", "detail", "resources", "army", "tech"]);
      } else {
        console.log("⚠️ Ключевых событий не зафиксировано (ИИ спамил экономику или бездействие).");
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
    const loadingScreen = document.getElementById("loadingScreen");
    if (loadingScreen) loadingScreen.style.display = "none";

    gameStarted = true; gameMode = "gnn";
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
      GnnAI._fallback = setInterval(() => GnnAI.tick(), 250);
    }

    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
    console.log("[GnnAI] 🚀 Матч начат (v6.0: Pure RL - ИИ учится сам!)");
  }

  function addMenuButton() {
    const loading = document.getElementById("loadingScreen");
    if (!loading || document.getElementById("gnnButton")) return;
    const btn = document.createElement("button");
    btn.id = "gnnButton"; btn.innerText = "Граф ИИ v6.0 (Pure RL)";
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
        GnnAI.tick(); return;
      }
      return origTick();
    };
  }

  window.GnnAI = GnnAI;
  window.startGnnGame = startGnnGame;

  window.addEventListener("load", () => {
    addMenuButton(); patchScheduler();
    console.log("[GnnAI] v6.0 загружен. ИИ учится сам через RL!");
  });
  addMenuButton(); patchScheduler();
})();