// ============================================================
// 03-evaluators.js — ПОЛНАЯ система наград
// ============================================================
"use strict";

// === ФЛАГ ОТЛАДКИ НАГРАД ===
// false = показывать только крупные события (>= 5.0 или <= -5.0)
// true = показывать каждое начисление (для глубокой отладки)
window.GNN_DEBUG_REWARDS = window.GNN_DEBUG_REWARDS || false;

Object.assign(window.GnnAI, {

  // === КОНСТАНТЫ (синхронизированы с entities.js) ===
  GAME_CONSTANTS: {
    // Вместимость зданий
    WAREHOUSE_WORKERS: 5,
    WORKSHOP_REPAIRMEN: 5,
    
    // Льготные периоды (мс)
    BUILDING_GRACE_PERIOD: 15000,      // 15 сек после постройки
    UNIT_PRODUCTION_GRACE: 10000,      // 10 сек после найма
    
    // Пороги времени (минуты)
    EARLY_GAME: 2.0,
    MID_GAME: 5.0,
    LATE_GAME: 10.0,
    
    // Стоимость (для проверки "может позволить")
    WORKER_COST: 13,        // 4+6+3
    WAREHOUSE_COST: 20,     // 12+5+3
    BARRACKS_COST: 108,     // 41+52+15
    BASE2_COST: 216,        // 81+92+43
    BEACON_COST: 77,        // 27+38+12
  },

  // ============================================================
  // ГРУППА 1: ЭКОНОМИКА
  // ============================================================

  // === Экономический паралич ===
  checkEconomicParalysis: function(now) {
    if (!this.lastEcoCheck || now - this.lastEcoCheck < 10000) return;
    this.lastEcoCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    
    if (gameTimeMin < 1.0) return;
    
    const workerCount = gameState.units.filter(u => 
      u.owner === "ai" && u.type === "worker" && u.health > 0
    ).length;
    
    const economyBuildings = gameState.buildings.filter(b => 
      b.owner === "ai" && (b.type === "warehouse" || b.type === "repairWorkshop") && b.active
    ).length;
    
    const lastBuildingTime = Math.max(...gameState.buildings
      .filter(b => b.owner === "ai" && (b.type === "warehouse" || b.type === "repairWorkshop"))
      .map(b => b.builtAt || 0), 0);
    
    const timeSinceLastBuilding = (now - lastBuildingTime) / 1000;
    
    if (economyBuildings > 0 && workerCount === 0 && timeSinceLastBuilding > 30) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ 
          X: currentState.X, 
          A_distance: currentState.A_distance, 
          A_threat: currentState.A_threat, 
          actionIndex: this._AIDX.idle, 
          reward: -3.0
        });
      }
    }
  },

  // === Миссии (атака, защита, найм, строительство, бездействие) ===
  evaluateMissions: function () {
    for (let i = this.missionCache.length - 1; i >= 0; i--) {
      const mission = this.missionCache[i];
      if (mission.resolved) { this.missionCache.splice(i, 1); continue; }
      
      let rewardDelta = 0;
      let isResolved = false;
      let reason = "";
      const m = this.metrics();

      // 1. АТАКА
      if (mission.intent.type === "attack") {
        const unitIds = mission.intent.unitIds || [];
        const logs = unitIds.map(id => {
          const u = gameState.units.find(x => x.id === id);
          return u ? u.missionLog : null;
        }).filter(Boolean);
        
        if (logs.length > 0) {
          const alive = logs.filter(l => l.alive);
          const dead = logs.filter(l => !l.alive);
          const completed = logs.filter(l => l.completedMission);
          const reached = logs.filter(l => l.reachedTarget);
          const totalDamageDealt = logs.reduce((s, l) => s + l.damageDealt, 0);
          const totalDamageTaken = logs.reduce((s, l) => s + l.damageTaken, 0);
          const hitByTurret = logs.some(l => l.hitByTurret);
          const diedToTurret = dead.some(l => l.killedBy && l.killedBy.type && l.killedBy.type.startsWith("turret"));

          const target = gameState.units.find(u => u.id === mission.snapshot.targetId) ||
                         gameState.buildings.find(b => b.id === mission.snapshot.targetId);
          const targetType = target ? target.type : "unknown";
          
          const getTargetImportance = (type) => {
            if (type === "base" || type === "base2" || type === "base3") return 100;
            if (type === "warehouse") return 80;
            if (type === "barracks" || type === "barracks2" || type === "barracks3") return 70;
            if (type === "repairWorkshop") return 60;
            if (type && type.startsWith("turret")) return 50;
            if (type === "beacon") return 40;
            if (type === "worker") return 15;
            if (type === "fighter") return 20;
            if (type === "assault") return 30;
            if (type === "elite") return 40;
            return 10;
          };
          const targetImportance = getTargetImportance(targetType);
          
          const elapsed = (performance.now() - mission.snapshot.time) / 1000;

          // Кешируем начальное расстояние к цели
          if (mission.snapshot.distToTarget === undefined && target && logs.length > 0) {
            const firstUnitId = unitIds[0];
            const fu = gameState.units.find(x => x.id === firstUnitId);
            if (fu) {
              mission.snapshot.distToTarget = Math.hypot(fu.x - target.x, fu.y - target.y);
            } else {
              mission.snapshot.distToTarget = 9999;
            }
          }

          // Промежуточные награды за прогресс
          if (elapsed > 3 && alive.length > 0 && target && target.health > 0) {
            const firstAliveUnit = gameState.units.find(x => x.id === unitIds[0] && x.health > 0);
            if (firstAliveUnit) {
              const currentDist = Math.hypot(firstAliveUnit.x - target.x, firstAliveUnit.y - target.y);
              const initialDist = mission.snapshot.distToTarget || 9999;
              const progress = Math.max(0, Math.min(1, (initialDist - currentDist) / Math.max(1, initialDist)));

              if (progress > 0.05) {
                const progressReward = progress * 2.0;
                mission.replayEntry.reward += progressReward;
              }
              if (totalDamageDealt > 0) {
                const dmgReward = Math.min(2.0, totalDamageDealt * 0.01);
                mission.replayEntry.reward += dmgReward;
              }
              if (progress < 0.02 && elapsed > 10) {
                mission.replayEntry.reward += -1.0;
              }
            }
          }

          // Минимальное время жизни миссии
          const MIN_MISSION_LIFE = 15;
          const MIN_MISSION_LIFE_WIPEOUT = 5;
          const canResolve = (alive.length === 0 && elapsed >= MIN_MISSION_LIFE_WIPEOUT) || elapsed >= MIN_MISSION_LIFE;

          if (canResolve) {
            isResolved = true;
            
            if (completed.length > 0) {
              const baseReward = targetImportance >= 50 ? 20.0 : 8.0;
              const damageBonus = totalDamageDealt * 0.05;
              const lossRatio = dead.length / logs.length;
              const lossPenalty = lossRatio * 10.0;
              
              rewardDelta = baseReward + damageBonus - lossPenalty;
              reason = `TARGET_DESTROYED: ${targetType} (важность: ${targetImportance}, потери: ${Math.round(lossRatio*100)}%)`;
              
              // Бонусы
              if (diedToTurret && dead.length > 0) {
                rewardDelta -= 8.0;
                reason += " +FRONTAL_TURRET_ASSAULT";
              }
              if (mission.snapshot.targetStartHP && mission.snapshot.targetStartHP < 100) {
                rewardDelta += 5.0;
                reason += " +FINISHING_BLOW";
              }
              const efficiency = totalDamageDealt / Math.max(1, totalDamageTaken);
              if (efficiency > 3 && targetImportance >= 50) {
                rewardDelta += 8.0;
                reason += ` +EFFICIENT_${efficiency.toFixed(1)}x`;
              }
              if (targetType === "worker" && completed.length > 0) {
                rewardDelta -= 3.0;
                reason += " +WORKER_HARASS_PENALTY";
              }
              if (elapsed < 15) {
                rewardDelta += 10.0;
                reason += " +BLITZ_EXECUTION";
              }
            } else if (alive.length === 0) {
              if (reached.length > 0) {
                rewardDelta = -5.0 + totalDamageDealt * 0.02;
                reason = "REACHED_BUT_DIED: дошли, но не уничтожили";
              } else if (diedToTurret) {
                rewardDelta = -10.0;
                reason = "DIED_TO_TURRETS: попали под турели";
              } else {
                rewardDelta = -8.0;
                reason = "TOTAL_WIPEOUT: армия уничтожена без результата";
              }
            } else if (reached.length > 0 && alive.length > 0) {
              if (elapsed > 5 && totalDamageDealt > 20) {
                rewardDelta = 2.0 + totalDamageDealt * 0.02;
                reason = "HOLDING_POSITION_AND_DEALING_DAMAGE";
              } else {
                rewardDelta = totalDamageDealt * 0.02;
                reason = "IN_PROGRESS: бой идёт";
              }
            } else if (alive.length === logs.length && reached.length === 0) {
              const stuckTime = (performance.now() - mission.snapshot.time) / 1000;
              if (stuckTime > 20) {
                isResolved = true;
                rewardDelta = -5.0;
                reason = `STUCK_NO_PROGRESS: ${stuckTime.toFixed(0)}с без достижения цели`;
              }
            }
          }
        }
      }
      
      // 2. ЗАЩИТА
      else if (mission.intent.type === "defend") {
        const anchor = (mission.snapshot.anchorId === "aiBase") ? window.aiBase : 
                       gameState.buildings.find(b => b.id === mission.snapshot.anchorId);
        
        if (!anchor) { isResolved = true; rewardDelta = -2.0; reason = "ANCHOR_MISSING"; }
        else {
          const enemiesNow = gameState.units.filter(u => 
            u.owner === "player" && u.health > 0 && 
            Math.hypot(u.x - anchor.x, u.y - anchor.y) < 300
          ).length;
          
          const enemiesAtStart = mission.snapshot.enemiesNearAnchorAtStart || 0;
          const aliveDefenders = (mission.intent.unitIds || []).reduce((sum, id) => {
            const u = gameState.units.find(x => x.id === id);
            return sum + (u && u.health > 0 ? 1 : 0);
          }, 0);
          const totalDefendersAtStart = mission.intent.unitIds ? mission.intent.unitIds.length : 0;
          
          const unitIds = mission.intent.unitIds || [];
          const logs = unitIds.map(id => {
            const u = gameState.units.find(x => x.id === id);
            return u ? u.missionLog : null;
          }).filter(Boolean);
          
          const totalDamageDealt = logs.reduce((s, l) => s + (l.damageDealt || 0), 0);
          const totalDamageTaken = logs.reduce((s, l) => s + (l.damageTaken || 0), 0);
          const lostDefenders = totalDefendersAtStart - aliveDefenders;
          
          const elapsed = (performance.now() - mission.snapshot.time) / 1000;
          
          if (elapsed >= 10 || (enemiesAtStart > 0 && enemiesNow === 0)) {
            isResolved = true;
            
            if (enemiesAtStart > 0 && enemiesNow === 0 && aliveDefenders > 0) {
              const hadRealCombat = totalDamageDealt > 50 || totalDamageTaken > 30 || lostDefenders > 0;
              if (hadRealCombat) {
                const efficiency = totalDamageDealt / Math.max(1, totalDamageTaken);
                rewardDelta = Math.min(30.0, 10.0 + efficiency * 5.0 + lostDefenders * 3.0);
                reason = `DEFENSE_SUCCESS: отбили атаку, урон ${totalDamageDealt.toFixed(0)}, потери ${lostDefenders}`;
              } else {
                rewardDelta = -3.0;
                reason = "DEFEND_WITHOUT_COMBAT: защитники не вступили в бой";
              }
            } else if (enemiesAtStart === 0 && enemiesNow === 0) {
              const recentEnemyPresence = gameState.units.some(u =>
                u.owner === "player" && u.health > 0 && anchor &&
                Math.hypot(u.x - anchor.x, u.y - anchor.y) < 500
              );
              if (recentEnemyPresence) {
                rewardDelta = 3.0;
                reason = "PREVENTIVE_DEFENSE: враг был рядом, но ушёл";
              } else {
                rewardDelta = -5.0;
                reason = "DEFENSE_NO_THREAT: защитники отправлены, но врага нет и не было";
              }
            } else if (totalDefendersAtStart > 0 && aliveDefenders === 0) {
              rewardDelta = -10.0;
              reason = "DEFENSE_FAILED: все защитники погибли";
            } else if (enemiesNow > 0 && aliveDefenders > 0) {
              rewardDelta = 0.3 + (totalDamageDealt > 0 ? 0.2 : 0);
              reason = "DEFENSE_ONGOING";
            }
          }
        }
      }
      
      // 3. НАЙМ
      else if (mission.intent.type === "hire") {
        const type = mission.intent.unitType;
        const elapsed = performance.now() - mission.snapshot.time;
        
        const unitAppeared = gameState.units.some(u => 
          u.owner === "ai" && u.type === type && u.health > 0 &&
          (performance.now() - (u.builtAt || 0)) < 10000
        );
        
        if (unitAppeared || elapsed > 15000) {
          isResolved = true;
          
          if (unitAppeared) {
            const rewards = {
              "worker": 3.0,
              "repairman": 2.0,
              "fighter": 5.0,
              "assault": 8.0,
              "elite": 12.0
            };
            rewardDelta = rewards[type] || 2.0;
            
            // Дополнительная проверка: нужен ли был этот юнит
            if (type === "worker") {
              const totalWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
              const totalWorkshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active).length;
              const neededWorkers = totalWarehouses * 5 + totalWorkshops * 5;
              const currentWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
              if (currentWorkers < neededWorkers) {
                rewardDelta += 2.0;
                reason = `WORKER_FILLED_DEFICIT: ${type}`;
              } else {
                reason = `UNIT_HIRED: ${type} (дефицита нет)`;
              }
            } else {
              reason = `UNIT_HIRED: ${type}`;
            }
          } else {
            rewardDelta = -2.0;
            reason = "HIRE_TIMEOUT";
          }
        }
      }
      
      // 4. СТРОИТЕЛЬСТВО
      else if (mission.intent.type === "build") {
        const bt = mission.intent.buildingType;
        const isBuilt = gameState.buildings.some(b => 
          b.owner === "ai" && b.type === bt && b.active
        );
        
        const elapsed = performance.now() - mission.snapshot.time;
        
        if (isBuilt || elapsed > 20000) {
          isResolved = true;
          
          if (isBuilt) {
            // Льготный период для складов/мастерских
            if (bt === "warehouse" || bt === "repairWorkshop") {
              const totalWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
              const totalWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
              const totalWorkshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active).length;
              const neededWorkers = totalWarehouses * 5 + totalWorkshops * 5;
              const gameTimeMin = performance.now() / 60000;
              
              const recentlyBuilt = gameState.buildings.filter(b => 
                b.owner === "ai" && b.type === bt && b.active && 
                (performance.now() - b.builtAt) < 15000
              ).length;
              
              const emptyWarehouses = gameState.buildings.filter(b => 
                b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) === 0
              ).length;
              const penalizedEmpty = Math.max(0, emptyWarehouses - recentlyBuilt);
              
              if (totalWorkers < neededWorkers && penalizedEmpty > 0 && gameTimeMin > 2.0) {
                rewardDelta = 5.0 - 2.0 * penalizedEmpty;
                reason = `BUILDING_BUILT_NEEDS_WORKERS: ${bt} (${penalizedEmpty} ждут рабочих)`;
              } else {
                rewardDelta = 8.0;
                reason = `BUILDING_BUILT: ${bt}`;
              }
            } else {
              const rewards = {
                "barracks": 10.0, "barracks2": 15.0, "barracks3": 20.0,
                "base2": 25.0, "base3": 30.0,
                "turret": 5.0, "turret2": 8.0, "turret3": 10.0,
                "beacon": 12.0
              };
              rewardDelta = rewards[bt] || 5.0;
              
              // Бонус за экспансию
              const builtObj = gameState.buildings.find(b => b.owner === "ai" && b.type === bt && b.active);
              if (builtObj) {
                const distFromBase = Math.hypot(builtObj.x - aiBase.x, builtObj.y - aiBase.y);
                if (distFromBase > 400) {
                  rewardDelta += 5.0;
                  reason = `BUILDING_BUILT_EXPANSION: ${bt} на расстоянии ${distFromBase.toFixed(0)}px`;
                } else {
                  reason = `BUILDING_BUILT: ${bt}`;
                }
                
                // Бонус за маяк с постройками
                if (bt === "beacon") {
                  const nearby = gameState.buildings.filter(b => 
                    b.owner === "ai" && b !== builtObj &&
                    ["warehouse","turret","turret2","turret3","barracks"].includes(b.type) &&
                    Math.hypot(b.x - builtObj.x, b.y - builtObj.y) < 250
                  ).length;
                  if (nearby >= 2) {
                    rewardDelta += 5.0;
                    reason += " +CLUSTER_ON_OUTPOST";
                  }
                }
              }
            }
          } else {
            rewardDelta = -3.0;
            reason = "BUILD_TIMEOUT";
          }
        }
      }
      
      // 5. БЕЗДЕЙСТВИЕ
      else if (mission.intent.type === "idle") {
        const gameTimeMin = performance.now() / 60000;
        const totalResRaw = (m.res.gold || 0) + (m.res.silicon || 0) + (m.res.plasma || 0);
        
        const canAffordWorker = totalResRaw >= this.GAME_CONSTANTS.WORKER_COST;
        const canAffordWarehouse = totalResRaw >= this.GAME_CONSTANTS.WAREHOUSE_COST;
        const canAffordBarracks = totalResRaw >= this.GAME_CONSTANTS.BARRACKS_COST;
        const canAffordBase2 = totalResRaw >= this.GAME_CONSTANTS.BASE2_COST;
        
        const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
        const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2" && b.active);
        const warehouseCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
        const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
        
        let criticalGoal = null;
        let criticalCost = 0;
        
        if (!hasBarracks && canAffordBarracks && gameTimeMin > 2.0) {
          criticalGoal = "barracks";
          criticalCost = this.GAME_CONSTANTS.BARRACKS_COST;
        } else if (!hasBase2 && hasBarracks && canAffordBase2 && gameTimeMin > 4.0) {
          criticalGoal = "base2";
          criticalCost = this.GAME_CONSTANTS.BASE2_COST;
        } else if (warehouseCount < 2 && canAffordWarehouse && gameTimeMin > 1.5) {
          criticalGoal = "warehouse";
          criticalCost = this.GAME_CONSTANTS.WAREHOUSE_COST;
        } else if (workerCount < warehouseCount * 5 && canAffordWorker && gameTimeMin > 1.0) {
          criticalGoal = "worker";
          criticalCost = this.GAME_CONSTANTS.WORKER_COST;
        }
        
        if (criticalGoal && totalResRaw >= criticalCost * 0.9) {
          rewardDelta = -5.0;
          reason = `IDLE_WHILE_CAN_BUILD: можно построить ${criticalGoal}`;
        } else if (totalResRaw > 100 && gameTimeMin > 3.0) {
          rewardDelta = 0.0;
          reason = "SAVING_FOR_EXPENSIVE_GOAL";
        } else {
          rewardDelta = 0.0;
          reason = "WAITING_FOR_RESOURCES";
        }
        
        if (gameTimeMin > 3.0 && m.aiArmy === 0 && totalResRaw > 100) {
          rewardDelta -= 3.0;
          reason += " +NO_ARMY_PANIC";
        }
        if (m.enemyNear > 0 && totalResRaw > 50) {
          rewardDelta -= 3.0;
          reason += " +IDLE_UNDER_THREAT";
        }
        
        isResolved = true;
      }

      // Применение награды
      if (isResolved || rewardDelta !== 0) {
        const clippedDelta = Math.max(-50.0, Math.min(50.0, rewardDelta));
        mission.replayEntry.reward += clippedDelta;
        if (isResolved) mission.resolved = true;
        
        // Умное логирование: только если включен режим отладки ИЛИ событие крупное (>= 5.0 или <= -5.0)
        if (window.GNN_DEBUG_REWARDS || Math.abs(clippedDelta) >= 5.0) {
          const sign = clippedDelta >= 0 ? '+' : '';
          const emoji = clippedDelta >= 5.0 ? '🟢' : (clippedDelta <= -5.0 ? '🔴' : '⚪');
          console.log(`[GnnAI ${emoji}] ${mission.action} → ${sign}${clippedDelta.toFixed(1)} | ${reason || 'no reason'}`);
        }
      }
    }
  },

  // === Эффективность экономики ===
  evaluateEconomyEfficiency: function (now) {
    if (!this.lastEcoEffCheck || now - this.lastEcoEffCheck < 6000) return;
    this.lastEcoEffCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let reward = 0;
    let reasons = [];
    
    const buildingCount = m.aiBuildings;
    const armyValue = gameState.units
      .filter(u => u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0)
      .reduce((s, u) => s + this.getUnitValue(u.type), 0);
    const techScore = m.techLevel * 100;
    const powerPerBuilding = (armyValue + techScore) / Math.max(1, buildingCount);
    
    // Штраф за раздутую инфраструктуру
    if (gameTimeMin > 3 && buildingCount > 14 && powerPerBuilding < 30) {
      reward -= 8.0;  // Было 12.0
      reasons.push(`BLOATED_INFRASTRUCTURE: ${buildingCount} зданий, сила/здание=${powerPerBuilding.toFixed(0)} < 30`);
    }
    
    // Бонус за эффективное использование
    if (this.lastBuildingCount > 0 && buildingCount <= this.lastBuildingCount) {
      const armyGrew = m.aiArmy > this.lastArmySize;
      const techGrew = m.techLevel > (this.lastTechLevel || 1);
      if (armyGrew || techGrew) {
        reward += 5.0;  // Было 10.0
        reasons.push(`EFFICIENT_CONVERSION: зданий ${buildingCount} (не +), но армия/тех выросли`);
      }
    }
    
    // Мягкий штраф за лишние маяки
    const beaconCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.active).length;
    if (beaconCount > 3) {
      const excess = beaconCount - 3;
      reward -= 5.0 * excess;  // Было 8.0
      reasons.push(`BEACON_OVERBUILD: ${beaconCount} маяков (штраф -${(5.0 * excess).toFixed(0)})`);
    }
    
    this.lastTechLevel = m.techLevel;
    
    if (reward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ 
          X: currentState.X, 
          A_distance: currentState.A_distance, 
          A_threat: currentState.A_threat, 
          actionIndex: this._AIDX.idle, 
          reward 
        });
      }
    }
  },

  // ============================================================
  // ГРУППА 2: РЕСУРСЫ И ЭКСПАНСИЯ
  // ============================================================

  // === Контроль ресурсов ===
  evaluateResourceControl: function (now) {
    if (!this.lastResourceControlCheck || now - this.lastResourceControlCheck < 5000) return;
    this.lastResourceControlCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = this.gameTimeMin();
    let reward = 0;
    let reasons = [];
    
    const allResources = gameState.resources.filter(r => r.amount > 0);
    if (allResources.length === 0) return;
    
    const myWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active);
    let myCoveredValue = 0;
    let playerCoveredValue = 0;
    let neutralValue = 0;
    
    const playerWarehouses = gameState.buildings.filter(b => b.owner === "player" && b.type === "warehouse" && b.active);
    
    allResources.forEach(r => {
      const value = r.amount || 0;
      const myCover = myWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
      const playerCover = playerWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
      
      if (myCover) myCoveredValue += value;
      else if (playerCover) playerCoveredValue += value;
      else neutralValue += value;
    });
    
    const totalValue = myCoveredValue + playerCoveredValue + neutralValue;
    const myShare = totalValue > 0 ? myCoveredValue / totalValue : 0;
    const playerShare = totalValue > 0 ? playerCoveredValue / totalValue : 0;
    
    // Награда за контроль
    if (myShare > 0.5) {
      reward += 10.0 * myShare;  // Было 15.0
      reasons.push(`RESOURCE_DOMINANCE: контролируем ${(myShare * 100).toFixed(0)}% ресурсов`);
    } else if (myShare > 0.3) {
      reward += 5.0;  // Было 8.0
      reasons.push(`GOOD_RESOURCE_CONTROL: контролируем ${(myShare * 100).toFixed(0)}% ресурсов`);
    } else if (myShare > 0.15) {
      reward += 2.0;  // Было 3.0
      reasons.push(`WEAK_RESOURCE_CONTROL: только ${(myShare * 100).toFixed(0)}% под контролем`);
    } else if (gameTimeMin > 3.0) {
      reward -= 5.0;  // Было 10.0
      reasons.push(`NO_RESOURCE_CONTROL: контролируем только ${(myShare * 100).toFixed(0)}% ресурсов`);
    }
    
    // Штраф за отставание
    if (playerShare > myShare * 1.5 && gameTimeMin > 2.0) {
      const gapPenalty = -8.0 * (playerShare - myShare);  // Было 12.0
      reward += gapPenalty;
      reasons.push(`RESOURCE_GAP: враг ${(playerShare * 100).toFixed(0)}%, мы ${(myShare * 100).toFixed(0)}%`);
    }
    
    // Бонус за стабильные форпосты
    const stableOutposts = gameState.buildings.filter(b =>
      b.owner === "ai" && b.type === "beacon" && b.active && b.builtAt &&
      (performance.now() - b.builtAt) > 120000 &&
      gameState.buildings.some(o =>
        o.owner === "ai" && o !== b &&
        ["warehouse","turret","turret2","turret3"].includes(o.type) &&
        Math.hypot(o.x - b.x, o.y - b.y) < 300
      )
    ).length;
    
    if (stableOutposts > 0) {
      reward += 3.0 * stableOutposts;  // Было 5.0
      reasons.push(`STABLE_OUTPOSTS: ${stableOutposts} форпостов удерживаются 2+ мин`);
    }
    
    if (reward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({
          X: currentState.X,
          A_distance: currentState.A_distance,
          A_threat: currentState.A_threat,
          actionIndex: this._AIDX.idle,
          reward
        });
      }
    }
  },

  // === Экспансия ===
  evaluateExpansion: function (now) {
    if (!this.lastExpansionCheck || now - this.lastExpansionCheck < 5000) return;
    this.lastExpansionCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let reward = 0;
    let reasons = [];
    
    const aiBuildings = gameState.buildings.filter(b =>
      b.owner === "ai" && b.health > 0 && b.type !== "base"
    );
    
    if (aiBuildings.length === 0) {
      if (gameTimeMin > 2.0) {
        reward -= 5.0;  // Было 10.0
        reasons.push("NO_EXPANSION: нет зданий за пределами базы");
      }
      if (reward !== 0) {
        const currentState = this.buildGraphState();
        if (currentState) {
          this.replay.push({
            X: currentState.X,
            A_distance: currentState.A_distance,
            A_threat: currentState.A_threat,
            actionIndex: this._AIDX.idle,
            reward
          });
        }
      }
      return;
    }
    
    // Подсчёт форпостов
    const outposts = [];
    const beacons = aiBuildings.filter(b => b.type === "beacon");
    beacons.forEach(beacon => {
      const nearby = aiBuildings.filter(b => Math.hypot(b.x - beacon.x, b.y - beacon.y) < 300);
      const hasTurret = nearby.some(b => b.type.startsWith("turret"));
      const hasWarehouse = nearby.some(b => b.type === "warehouse");
      const hasWorkshop = nearby.some(b => b.type === "repairWorkshop");
      const hasBarracks = nearby.some(b => b.type.startsWith("barracks"));
      const score = (hasTurret ? 1 : 0) + (hasWarehouse ? 1 : 0) + (hasWorkshop ? 1 : 0) + (hasBarracks ? 1 : 0);
      
      if (score >= 3) {
        outposts.push({ beacon, score, buildings: nearby });
      }
    });
    
    // Награда за форпосты
    if (outposts.length > 0) {
      let outpostReward = 0;
      for (let i = 0; i < outposts.length; i++) {
        if (i === 0) outpostReward += 15.0;  // Было 25.0
        else if (i === 1) outpostReward += 12.0;  // Было 20.0
        else if (i === 2) outpostReward += 10.0;  // Было 15.0
        else outpostReward += 8.0;  // Было 10.0
      }
      reward += outpostReward;
      reasons.push(`OUTPOSTS_BUILT: ${outposts.length} форпостов (+${outpostReward.toFixed(1)})`);
      
      // Штраф за стагнацию
      if (outposts.length === 1 && gameTimeMin > 6.0) {  // Было 5.0
        reward -= 5.0;  // Было 10.0
        reasons.push("STAGNANT_EXPANSION: только 1 форпост после 6 минут");
      }
    } else if (gameTimeMin > 4.0 && m.resTotal > 0.3) {  // Было 3.0
      reward -= 8.0;  // Было 15.0
      reasons.push("NO_OUTPOSTS: нет форпостов после 4 минут");
    }
    
    // Проверка распределения зданий
    if (aiBuildings.length >= 5) {
      let totalDist = 0;
      let pairCount = 0;
      for (let i = 0; i < Math.min(aiBuildings.length, 15); i++) {
        for (let j = i + 1; j < Math.min(aiBuildings.length, 15); j++) {
          totalDist += Math.hypot(aiBuildings[i].x - aiBuildings[j].x, aiBuildings[i].y - aiBuildings[j].y);
          pairCount++;
        }
      }
      const avgDist = pairCount > 0 ? totalDist / pairCount : 0;
      
      if (avgDist < 150) {
        reward -= 8.0;  // Было 15.0
        reasons.push(`BUILDING_CLUSTER: здания слишком близко (среднее ${avgDist.toFixed(0)}px)`);
      } else if (avgDist > 400) {
        reward += 5.0;  // Было 10.0
        reasons.push(`GOOD_SPREAD: здания хорошо распределены (среднее ${avgDist.toFixed(0)}px)`);
      }
    }
    
    if (reward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({
          X: currentState.X,
          A_distance: currentState.A_distance,
          A_threat: currentState.A_threat,
          actionIndex: this._AIDX.idle,
          reward
        });
      }
    }
  },

  // ============================================================
  // ГРУППА 3: ВОЕННАЯ МОЩЬ
  // ============================================================

  // === Военный баланс ===
  evaluateMilitaryBalance: function (now) {
    if (!this.lastMilitaryCheck || now - this.lastMilitaryCheck < 3000) return;
    this.lastMilitaryCheck = now;
    
    const m = this.metrics();
    let penalty = 0;
    let reasons = [];
    
    const myUnits = gameState.units.filter(u => u.owner === "ai" && u.health > 0);
    const enemyUnits = gameState.units.filter(u => u.owner === "player" && u.health > 0);
    
    let myPower = 0;
    myUnits.forEach(u => { myPower += u.health + (this.getUnitDps(u.type) || 0) * 10; });
    
    let enemyPower = 0;
    enemyUnits.forEach(u => { enemyPower += u.health + (this.getUnitDps(u.type) || 10); });
    
    const turretCount = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0).length;
    const myDefensePower = turretCount * 150;
    const totalMyStrength = myPower + myDefensePower;
    
    if (enemyPower > 0) {
      if (totalMyStrength < enemyPower * 0.5) { 
        penalty -= 5.0;  // Было 10.0
        reasons.push("CRITICAL_WEAK_DEFENSE: Враг в 2 раза сильнее"); 
      } else if (totalMyStrength > enemyPower * 1.5) { 
        penalty += 3.0;  // Было 5.0
        reasons.push("STRONG_DEFENSE: Превосходство в силе"); 
      }
    }
    
    if (m.enemyNear > 0 && m.baseHp > 0.95 && turretCount > 0) { 
      penalty += 2.0;  // Было 3.0
      reasons.push("EFFECTIVE_DEFENSE: База цела под огнем"); 
    }
    
    if (penalty !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ 
          X: currentState.X, 
          A_distance: currentState.A_distance, 
          A_threat: currentState.A_threat, 
          actionIndex: this._AIDX.idle, 
          reward: penalty 
        });
      }
    }
  },

  // === Отставание от противника ===
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
      penalty -= 8.0;  // Было 15.0
      reasons.push(`ECONOMIC_LAG: У врага ${enemyWorkers} рабочих, у нас ${myWorkers}`);
    }
    
    const enemyArmyValue = gameState.units.filter(u => u.owner === "player" && u.health > 0).reduce((sum, u) => sum + this.getUnitValue(u.type), 0);
    const myArmyValue = m.aiArmy * 30;
    
    if (gameTimeMin > 2.0 && enemyArmyValue > myArmyValue + 150) {
      penalty -= 10.0;  // Было 20.0
      reasons.push("MILITARY_LAG: Враг превосходит в силе");
    }
    
    const enemyHasBase2 = gameState.buildings.some(b => b.owner === "player" && b.type === "base2");
    const myHasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2");
    
    if (gameTimeMin > 4.0 && enemyHasBase2 && !myHasBase2) {
      penalty -= 12.0;  // Было 25.0
      reasons.push("TECH_LAG: Враг перешел на Тир-2, а мы застряли");
    }
    
    if (penalty < 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ 
          X: currentState.X, 
          A_distance: currentState.A_distance, 
          A_threat: currentState.A_threat, 
          actionIndex: this._AIDX.idle, 
          reward: penalty 
        });
      }
    }
  },

  // === Активность армии ===
  evaluateArmyActivity: function (now) {
    if (!this.lastArmyActivityCheck || now - this.lastArmyActivityCheck < 4000) return;
    this.lastArmyActivityCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let reward = 0;
    let reasons = [];
    
    const combatUnits = gameState.units.filter(u =>
      u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
    );
    
    if (combatUnits.length === 0) return;
    
    let busyUnits = 0, attackingUnits = 0, defendingUnits = 0, idleUnits = 0;
    
    combatUnits.forEach(u => {
      if (u.commandQueue && u.commandQueue.length > 0) {
        busyUnits++;
        const hasAttack = u.commandQueue.some(cmd => cmd.type === "attack");
        const hasMove = u.commandQueue.some(cmd => cmd.type === "move");
        if (hasAttack) attackingUnits++;
        else if (hasMove && u.defending) defendingUnits++;
      } else {
        idleUnits++;
      }
    });
    
    const idleRatio = idleUnits / combatUnits.length;
    
    // Штраф за бездействие (смягчён)
    if (combatUnits.length >= 3 && idleRatio > 0.7 && gameTimeMin > 2.5) {
      reward -= 10.0 * idleRatio;  // Было 20.0
      reasons.push(`ARMY_IDLE_CRITICAL: ${idleUnits}/${combatUnits.length} бойцов без команд`);
    } else if (combatUnits.length >= 2 && idleRatio > 0.5 && gameTimeMin > 2.0) {
      reward -= 5.0 * idleRatio;  // Было 10.0
      reasons.push(`ARMY_IDLE: ${idleUnits}/${combatUnits.length} бойцов без команд`);
    }
    
    // Бонус за атаки
    if (attackingUnits >= 2) {
      reward += 8.0;  // Было 15.0
      reasons.push(`ARMY_ATTACKING: ${attackingUnits} бойцов в атаке`);
    }
    
    // Бонус за защиту
    if (defendingUnits >= 2 && m.enemyNear > 0) {
      reward += 5.0;  // Было 10.0
      reasons.push(`ARMY_DEFENDING: ${defendingUnits} бойцов защищают`);
    }
    
    // Штраф за панику движка
    const panicRetreatUnits = combatUnits.filter(u => u.isRetreating === true).length;
    if (panicRetreatUnits > 0) {
      reward -= 10.0 * panicRetreatUnits;
      reasons.push(`ENGINE_PANIC: ${panicRetreatUnits} юнитов в панике`);
    }
    
    // Бонус за разнообразие
    if (attackingUnits > 0 && defendingUnits > 0) {
      reward += 5.0;  // Было 8.0
      reasons.push(`ARMY_DIVERSITY: армия разделена на атаку (${attackingUnits}) и защиту (${defendingUnits})`);
    }
    
    if (reward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({
          X: currentState.X,
          A_distance: currentState.A_distance,
          A_threat: currentState.A_threat,
          actionIndex: this._AIDX.idle,
          reward
        });
      }
    }
  },

  // === Эффективность боя ===
  evaluateCombatEfficiency: function (now) {
    if (!this.lastCombatEfficiencyCheck || now - this.lastCombatEfficiencyCheck < 6000) return;
    this.lastCombatEfficiencyCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let reward = 0;
    let reasons = [];
    
    const myCombatUnits = gameState.units.filter(u =>
      u.owner === "ai" && ["fighter","assault","elite"].includes(u.type)
    );
    const aliveMyUnits = myCombatUnits.filter(u => u.health > 0);
    const enemyCombatUnits = gameState.units.filter(u =>
      u.owner === "player" && ["fighter","assault","elite"].includes(u.type)
    );
    const aliveEnemyUnits = enemyCombatUnits.filter(u => u.health > 0);
    
    let currentDamageDealt = 0, currentDamageTaken = 0;
    let killedEnemies = 0, lostAllies = 0;
    
    this.missionCache.forEach(mission => {
      if (mission.resolved || mission.intent.type !== "attack") return;
      const unitIds = mission.intent.unitIds || [];
      unitIds.forEach(id => {
        const u = gameState.units.find(x => x.id === id);
        if (u && u.missionLog) {
          currentDamageDealt += u.missionLog.damageDealt || 0;
          currentDamageTaken += u.missionLog.damageTaken || 0;
          if (!u.missionLog.alive) lostAllies++;
          const killEvents = (u.missionLog.events || []).filter(e =>
            e.type === "target_destroyed" && e.to && e.to.owner === "player"
          );
          killedEnemies += killEvents.length;
        }
      });
    });
    
    const deltaDamageDealt = currentDamageDealt - (this._lastDamageDealt || 0);
    const deltaDamageTaken = currentDamageTaken - (this._lastDamageTaken || 0);
    const deltaKills = killedEnemies - (this._lastKillCount || 0);
    const deltaDeaths = lostAllies - (this._lastDeathCount || 0);
    
    this._lastDamageDealt = currentDamageDealt;
    this._lastDamageTaken = currentDamageTaken;
    this._lastKillCount = killedEnemies;
    this._lastDeathCount = lostAllies;
    
    // K/D ratio
    if (deltaDeaths > 0 || deltaKills > 0) {
      const kdRatio = deltaKills / Math.max(1, deltaDeaths);
      if (kdRatio >= 2.0 && deltaKills >= 2) {
        reward += 15.0;  // Было 25.0
        reasons.push(`EXCELLENT_KD: убито ${deltaKills}, потеряно ${deltaDeaths} (K/D=${kdRatio.toFixed(2)})`);
      } else if (kdRatio >= 1.0 && deltaKills >= 1) {
        reward += 5.0;  // Было 8.0
        reasons.push(`GOOD_KD: убито ${deltaKills}, потеряно ${deltaDeaths}`);
      } else if (kdRatio < 0.5 && deltaDeaths >= 2) {
        reward -= 8.0;  // Было 12.0
        reasons.push(`BAD_KD: убито ${deltaKills}, потеряно ${deltaDeaths}`);
      }
    }
    
    // Эффективность урона
    if (deltaDamageDealt > 50 && deltaDamageTaken > 0) {
      const damageEfficiency = deltaDamageDealt / deltaDamageTaken;
      if (damageEfficiency > 2.0) {
        reward += 8.0;  // Было 15.0
        reasons.push(`DAMAGE_EFFICIENT: нанесли ${deltaDamageDealt.toFixed(0)}, получили ${deltaDamageTaken.toFixed(0)}`);
      }
    }
    
    // Здоровье армии
    if (aliveMyUnits.length >= 3 && gameTimeMin > 3.0) {
      const healthyUnits = aliveMyUnits.filter(u => u.health > u.maxHealth * 0.7).length;
      const healthRatio = healthyUnits / aliveMyUnits.length;
      if (healthRatio >= 0.8) {
        reward += 3.0;  // Было 5.0
        reasons.push(`ARMY_HEALTHY: ${healthyUnits}/${aliveMyUnits.length} юнитов здоровы`);
      }
    }
    
    if (reward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({
          X: currentState.X,
          A_distance: currentState.A_distance,
          A_threat: currentState.A_threat,
          actionIndex: this._AIDX.idle,
          reward
        });
      }
    }
  },

  // === Качество выбора целей ===
  evaluateTargetSelection: function (now) {
    if (!this.lastTargetSelectionCheck || now - this.lastTargetSelectionCheck < 8000) return;
    this.lastTargetSelectionCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let reward = 0;
    let reasons = [];
    
    const recentAttacks = this.missionCache.filter(m =>
      m.resolved && m.intent.type === "attack" &&
      (now - m.snapshot.time) < 30000
    );
    
    if (recentAttacks.length === 0) return;
    
    let goodTargets = 0, badTargets = 0, isolatedTargets = 0;
    let totalDamageDealt = 0, totalDamageTaken = 0, totalLosses = 0;
    
    recentAttacks.forEach(mission => {
      const unitIds = mission.intent.unitIds || [];
      const targetId = mission.snapshot.targetId;
      const target = gameState.units.find(u => u.id === targetId) ||
                     gameState.buildings.find(b => b.id === targetId);
      
      if (!target) return;
      
      const enemyTurrets = gameState.buildings.filter(b =>
        b.owner === "player" && b.type?.startsWith("turret") && b.health > 0
      );
      const turretsNearTarget = enemyTurrets.filter(t =>
        Math.hypot(t.x - target.x, t.y - target.y) < 300
      ).length;
      
      const enemyUnits = gameState.units.filter(u => u.owner === "player" && u.health > 0);
      const enemiesNearTarget = enemyUnits.filter(u =>
        Math.hypot(u.x - target.x, u.y - target.y) < 250
      ).length;
      
      const isIsolated = enemiesNearTarget === 0 && turretsNearTarget === 0;
      
      const logs = unitIds.map(id => {
        const u = gameState.units.find(x => x.id === id);
        return u ? u.missionLog : null;
      }).filter(Boolean);
      
      const damageDealt = logs.reduce((s, l) => s + (l.damageDealt || 0), 0);
      const damageTaken = logs.reduce((s, l) => s + (l.damageTaken || 0), 0);
      const losses = logs.filter(l => !l.alive).length;
      
      totalDamageDealt += damageDealt;
      totalDamageTaken += damageTaken;
      totalLosses += losses;
      
      if (isIsolated && damageDealt > 50) { goodTargets++; isolatedTargets++; }
      else if (damageDealt > 100 && losses === 0) { goodTargets++; }
      else if (losses > 2 && damageDealt < 50) { badTargets++; }
    });
    
    if (goodTargets > 0) {
      reward += 10.0;  // Было 20.0
      reasons.push(`GOOD_TARGETS: ${goodTargets} хорошо выбранных целей`);
    }
    
    if (isolatedTargets > 0) {
      reward += 8.0;  // Было 15.0
      reasons.push(`ISOLATED_TARGETS: ${isolatedTargets} изолированных целей`);
    }
    
    if (badTargets > 0) {
      reward -= 8.0;  // Было 12.0
      reasons.push(`BAD_TARGETS: ${badTargets} плохо выбранных целей`);
    }
    
    if (reward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({
          X: currentState.X,
          A_distance: currentState.A_distance,
          A_threat: currentState.A_threat,
          actionIndex: this._AIDX.idle,
          reward
        });
      }
    }
  },

  // ============================================================
  // ГРУППА 4: РАЗВЕДКА
  // ============================================================

  // === Разведка ===
  evaluateRecon: function (now) {
    if (!this.lastReconCheck || now - this.lastReconCheck < 3000) return;
    this.lastReconCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let reward = 0;
    let reasons = [];
    
    const combatUnits = gameState.units.filter(u =>
      u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
    );
    
    let newEnemySightings = 0;
    let importantEnemySightings = 0;
    const visionRadius = 300;
    
    combatUnits.forEach(u => {
      const enemiesNear = gameState.units.filter(e =>
        e.owner === "player" && e.health > 0 &&
        Math.hypot(e.x - u.x, e.y - u.y) < visionRadius
      );
      newEnemySightings += enemiesNear.length;
      const importantNear = enemiesNear.filter(e =>
        ["base","base2","base3","warehouse","barracks","turret","turret2","turret3"].includes(e.type)
      );
      importantEnemySightings += importantNear.length;
    });
    
    if (importantEnemySightings > 0) {
      reward += 10.0;  // Было 20.0
      reasons.push(`INTEL_FOUND: обнаружено ${importantEnemySightings} важных целей`);
    } else if (newEnemySightings > 0) {
      reward += 5.0;  // Было 10.0
      reasons.push(`INTEL_FOUND: обнаружено ${newEnemySightings} врагов`);
    }
    
    if (reward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({
          X: currentState.X,
          A_distance: currentState.A_distance,
          A_threat: currentState.A_threat,
          actionIndex: this._AIDX.idle,
          reward
        });
      }
    }
  },

  // === Разведка новых узлов ===
  evaluateReconDiscovery: function (now) {
    if (!this.lastReconDiscoveryCheck || now - this.lastReconDiscoveryCheck < 2000) return;
    this.lastReconDiscoveryCheck = now;
    
    let reward = 0;
    let reasons = [];
    const gameTimeMin = performance.now() / 60000;
    const recentDiscoveries = [];
    const valuableDiscoveries = [];
    
    for (const [key, mem] of this.reconMemory.entries()) {
      if (mem.owner === "player" && (now - mem.lastSeen) < 2000) {
        if (!mem._rewarded) {
          recentDiscoveries.push(mem);
          mem._rewarded = true;
          mem._firstSeenAt = now;
          const isImportant = ["base","base2","base3","barracks","barracks2","barracks3","warehouse","turret","turret2","turret3"].includes(mem.type);
          if (isImportant) {
            valuableDiscoveries.push({ mem, value: 10.0 });
          }
        }
      }
    }
    
    if (recentDiscoveries.length > 0) {
      reward += 3.0 * Math.min(3, recentDiscoveries.length);  // Было 3.0 * capped
      reasons.push(`RECON_DISCOVERY: обнаружено ${recentDiscoveries.length} объектов`);
    }
    
    if (valuableDiscoveries.length > 0) {
      reward += 5.0 * Math.min(2, valuableDiscoveries.length);  // Было по 12-20
      reasons.push(`IMPORTANT_RECON: ${valuableDiscoveries.length} важных целей`);
    }
    
    if (reward !== 0) {
      const state = this.buildGraphState();
      if (state) {
        this.replay.push({ 
          X: state.X, 
          A_distance: state.A_distance, 
          A_threat: state.A_threat, 
          actionIndex: this._AIDX.idle, 
          reward 
        });
      }
    }
  },

  // ============================================================
  // ГРУППА 5: ФАЗОВЫЕ НАГРАДЫ И СТАГНАЦИЯ
  // ============================================================

  // === Фазовые награды ===
  evaluatePhaseRewards: function (now) {
    if (!this.lastPhaseCheck || now - this.lastPhaseCheck < 5000) return;
    this.lastPhaseCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    const workers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
    const warehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
    const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
    const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2" && b.active);
    const armySize = m.aiArmy;
    
    let phaseReward = 0;
    let reasons = [];
    
    // === РАННЯЯ ИГРА (0-2 мин) ===
    if (gameTimeMin < 2.0) {
      if (workers >= 3) {
        phaseReward += 5.0;
        reasons.push("PHASE1_EXCELLENT_ECONOMY: 3+ рабочих");
      } else if (workers >= 1) {
        phaseReward += 2.0;
        reasons.push("PHASE1_GOOD_ECONOMY: есть рабочие");
      }
      
      if (warehouses >= 2) {
        phaseReward += 3.0;
        reasons.push("PHASE1_INFRASTRUCTURE: 2+ склада");
      }
      
      // Мягкий штраф за отсутствие рабочих
      if (gameTimeMin > 1.5 && workers < 2) {
        phaseReward -= 8.0;  // Было 30.0
        reasons.push("PHASE1_SLOW_ECONOMY: только 1 рабочий после 1.5 мин");
      }
    }
    
    // === СРЕДНЯЯ ИГРА (2-5 мин) ===
    else if (gameTimeMin < 5.0) {
      if (hasBarracks && workers >= 3) {
        phaseReward += 8.0;
        reasons.push("PHASE2_BALANCED: казарма + 3 рабочих");
      }
      
      if (armySize > 0 && workers < 3) {
        phaseReward -= 5.0;  // Было 15.0
        reasons.push("PHASE2_WEAK_ECONOMY: армия есть, но мало рабочих");
      }
      
      const hasBarracksPhase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
      const unitsInProduction = gameState.buildings.filter(b => 
        b.owner === "ai" && b.productionQueue && b.productionQueue.length > 0
      ).reduce((sum, b) => sum + b.productionQueue.length, 0);
      
      if (armySize === 0 && gameTimeMin > 3.0) {
        if (hasBarracksPhase2 || unitsInProduction > 0) {
          phaseReward -= 3.0;  // Было 15.0
          reasons.push("PHASE2_ARMY_IN_PRODUCTION: казарма строит юнитов");
        } else {
          phaseReward -= 8.0;  // Было 15.0
          reasons.push("PHASE2_ZERO_ARMY: нет армии");
        }
      }
    }
    
    // === ПОЗДНЯЯ ИГРА (5+ мин) ===
    else {
      if (hasBase2) {
        phaseReward += 15.0;
        reasons.push("PHASE3_TIER2: база2 построена");
      }
      
      if (!hasBase2 && gameTimeMin > 6.0) {
        phaseReward -= 10.0;  // Было больше
        reasons.push("PHASE3_NO_BASE2: нет базы2 после 6 минут");
      }
      
      const eliteCount = gameState.units.filter(u => u.owner === "ai" && u.type === "elite").length;
      const assaultCount = gameState.units.filter(u => u.owner === "ai" && u.type === "assault").length;
      
      if (eliteCount > 0) {
        phaseReward += 10.0;  // Было 20.0
        reasons.push("PHASE4_ELITE_UNITS: есть элита");
      }
      
      if (assaultCount > 0) {
        phaseReward += 5.0;  // Было 10.0
        reasons.push("PHASE4_ASSAULT_UNITS: есть штурмовики");
      }
    }
    
    if (phaseReward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ 
          X: currentState.X, 
          A_distance: currentState.A_distance, 
          A_threat: currentState.A_threat, 
          actionIndex: this._AIDX.idle, 
          reward: phaseReward 
        });
      }
    }
  },

  // === Стагнация ===
  evaluateStagnation: function (now) {
    if (now - this.lastStagnationCheck < 5000) return;
    this.lastStagnationCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let penalty = 0;
    let reasons = [];
    
    // === ЭКОНОМИКА ===
    const workers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
    const warehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
    
    // Штраф за пустые склады ТОЛЬКО после льготного периода
    const emptyWarehouses = gameState.buildings.filter(b => 
      b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) === 0 &&
      (performance.now() - b.builtAt) > this.GAME_CONSTANTS.BUILDING_GRACE_PERIOD
    ).length;
    
    if (emptyWarehouses > 0 && gameTimeMin > 2.0) {
      const canAffordWorkers = (m.res.gold || 0) >= 4 && (m.res.silicon || 0) >= 6 && (m.res.plasma || 0) >= 3;
      if (canAffordWorkers) {
        penalty -= 3.0 * emptyWarehouses;  // Было 10.0
        reasons.push(`EMPTY_WAREHOUSES: ${emptyWarehouses} складов без рабочих`);
      }
    }
    
    // === АРМИЯ ===
    const armySize = m.aiArmy;
    const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
    const unitsInProduction = gameState.buildings.filter(b => 
      b.owner === "ai" && b.productionQueue && b.productionQueue.length > 0
    ).reduce((sum, b) => sum + b.productionQueue.length, 0);
    
    if (gameTimeMin > 3.0 && armySize === 0 && !hasBarracks && unitsInProduction === 0) {
      penalty -= 5.0;  // Было больше
      reasons.push("NO_ARMY_NO_PRODUCTION: нет армии и не строится");
    }
    
    // === ЭКСПАНСИЯ ===
    const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2" && b.active);
    const base2InQueue = (window.buildQueue || []).some(q => q.type === "base2");
    
    if (gameTimeMin > 6.0 && !hasBase2 && !base2InQueue && m.resTotal > 0.3) {
      penalty -= 8.0;  // Было больше
      reasons.push("LATE_EXPANSION: нет базы2 после 6 минут");
    }
    
    // === ТУРЕЛИ ===
    const turretCount = gameState.buildings.filter(b => 
      b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0
    ).length;
    
    if (turretCount >= 4 && armySize < 3 && gameTimeMin > 5.0 && !hasBarracks) {
      penalty -= 10.0;  // Было 25.0
      reasons.push("TURTLE_STRATEGY: много турелей, но нет казармы");
    }
    
    if (penalty !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({
          X: currentState.X,
          A_distance: currentState.A_distance,
          A_threat: currentState.A_threat,
          actionIndex: this._AIDX.idle,
          reward: penalty
        });
      }
    }
    
    this.lastArmySize = m.aiArmy;
    this.lastBuildingCount = m.aiBuildings;
    this.lastResourceTotal = m.resTotal;
  },

  // === Технологическая стагнация ===
  checkTechStagnation: function (now) {
    if (!this.lastTechStagnationCheck || now - this.lastTechStagnationCheck < 10000) return;
    this.lastTechStagnationCheck = now;
    
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let penalty = 0;
    let reasons = [];
    
    const hasNoArmy = m.aiArmy === 0;
    
    if (hasNoArmy && m.resTotal > 0.2 && gameTimeMin > 1.5) {
      penalty -= 10.0;  // Было 30.0
      reasons.push("CRITICAL_PANIC: Ресурсы есть, а армии НЕТ");
    }
    
    const hasEconomyBuildings = gameState.buildings.some(b => b.owner === "ai" && (b.type === "warehouse" || b.type === "repairWorkshop") && b.active);
    const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
    
    if (hasEconomyBuildings && workerCount === 0 && gameTimeMin > 0.5) {
      penalty -= 8.0;  // Было 20.0
      reasons.push("CRITICAL: buildings_without_workers");
    }
    
    if (penalty !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ 
          X: currentState.X, 
          A_distance: currentState.A_distance, 
          A_threat: currentState.A_threat, 
          actionIndex: this._AIDX.idle, 
          reward: penalty 
        });
      }
    }
    
    this.lastResourceTotal = m.resTotal;
  }

});