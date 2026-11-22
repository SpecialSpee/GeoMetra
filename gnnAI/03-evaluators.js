// ============================================================
// 03-evaluators.js — ПОЛНАЯ система наград (ФИНАЛЬНАЯ ОЧИЩЕННАЯ ВЕРСИЯ)
// ============================================================
"use strict";
window.GNN_DEBUG_REWARDS = window.GNN_DEBUG_REWARDS || false;

Object.assign(window.GnnAI, {
  GAME_CONSTANTS: {
    WAREHOUSE_WORKERS: 5, WORKSHOP_REPAIRMEN: 5, BUILDING_GRACE_PERIOD: 15000,
    UNIT_PRODUCTION_GRACE: 10000, EARLY_GAME: 2.0, MID_GAME: 5.0, LATE_GAME: 10.0,
    WORKER_COST: 13, WAREHOUSE_COST: 20, BARRACKS_COST: 108, BASE2_COST: 216, BEACON_COST: 77,
  },
  // === Экономический паралич (ЭВРИСТИКА, без replay) ===
  checkEconomicParalysis: function(now) {
    if (!this.lastEcoCheck || now - this.lastEcoCheck < 10000) return;
    this.lastEcoCheck = now;
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    if (gameTimeMin < 1.0) return;
    
    const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
    const economyBuildings = gameState.buildings.filter(b => b.owner === "ai" && (b.type === "warehouse" || b.type === "repairWorkshop") && b.active).length;
    const lastBuildingTime = Math.max(...gameState.buildings.filter(b => b.owner === "ai" && (b.type === "warehouse" || b.type === "repairWorkshop")).map(b => b.builtAt || 0), 0);
    
    if (economyBuildings > 0 && workerCount === 0 && (now - lastBuildingTime) / 1000 > 30) {
      // Эвристика: можно добавить логику экстренного найма, но в replay не пишем
    }
  },
  // === Миссии (ЕДИНСТВЕННЫЙ ИСТОЧНИК НАГРАД ДЛЯ REPLAY) ===
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
        
        const elapsed = (performance.now() - mission.snapshot.time) / 1000;
        
        if (logs.length === 0 && unitIds.length > 0 && elapsed >= 5) {
            isResolved = true; rewardDelta = -3.0; reason = "TOTAL_WIPEOUT_GHOST";
        } else if (logs.length > 0) {
          const alive = logs.filter(l => l.alive);
          const dead = logs.filter(l => !l.alive);
          const completed = logs.filter(l => l.completedMission);
          const reached = logs.filter(l => l.reachedTarget);
          const totalDamageDealt = logs.reduce((s, l) => s + l.damageDealt, 0);
          const totalDamageTaken = logs.reduce((s, l) => s + l.damageTaken, 0);
          const diedToTurret = dead.some(l => l.killedBy && l.killedBy.type && l.killedBy.type.startsWith("turret"));

          const target = gameState.units.find(u => u.id === mission.snapshot.targetId) || gameState.buildings.find(b => b.id === mission.snapshot.targetId);
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

          if (mission.snapshot.distToTarget === undefined && target && logs.length > 0) {
            const fu = gameState.units.find(x => x.id === unitIds[0]);
            mission.snapshot.distToTarget = fu ? Math.hypot(fu.x - target.x, fu.y - target.y) : 9999;
          }

          // Промежуточные награды (раз в секунду, не каждый кадр!)
          if (elapsed > 3 && alive.length > 0 && target && target.health > 0) {
            if (mission._lastIntermediateTick === undefined) mission._lastIntermediateTick = 0;
            if (elapsed - mission._lastIntermediateTick >= 1.0) {
              const firstAliveUnit = gameState.units.find(x => x.id === unitIds[0] && x.health > 0);
              if (firstAliveUnit) {
                const currentDist = Math.hypot(firstAliveUnit.x - target.x, firstAliveUnit.y - target.y);
                const initialDist = mission.snapshot.distToTarget || 9999;
                const progress = Math.max(0, Math.min(1, (initialDist - currentDist) / Math.max(1, initialDist)));
                if (progress > 0.05) mission.replayEntry.reward += progress * 1.0;
                if (totalDamageDealt > 0) mission.replayEntry.reward += Math.min(1.0, totalDamageDealt * 0.005);
              }
              mission._lastIntermediateTick = elapsed;
            }
          }

          const canResolve = (alive.length === 0 && elapsed >= 5) || elapsed >= 15;
          if (canResolve) {
            isResolved = true;
            if (completed.length > 0) {
              const baseReward = targetImportance >= 50 ? 20.0 : 8.0;
              const lossRatio = dead.length / logs.length;
              rewardDelta = baseReward + (totalDamageDealt * 0.05) - (lossRatio * 10.0);
              reason = `TARGET_DESTROYED: ${targetType}`;
              if (diedToTurret && dead.length > 0) { rewardDelta -= 5.0; reason += " +FRONTAL_TURRET"; }
              if (elapsed < 15) { rewardDelta += 5.0; reason += " +BLITZ"; }
            } else if (alive.length === 0) {
              if (reached.length > 0) { rewardDelta = -2.0 + (totalDamageDealt * 0.05); reason = "REACHED_BUT_DIED"; } 
              else if (diedToTurret) { rewardDelta = -3.0; reason = "DIED_TO_TURRETS"; } 
              else { rewardDelta = -4.0; reason = "TOTAL_WIPEOUT"; }
            } else if (reached.length > 0 && alive.length > 0) {
              rewardDelta = 1.0 + (totalDamageDealt * 0.02); reason = "HOLDING_POSITION";
            } else {
              rewardDelta = -2.0; reason = "STUCK_NO_PROGRESS";
            }
          }
        }
      }
      
      // 2. ЗАЩИТА
      else if (mission.intent.type === "defend") {
        const anchor = (mission.snapshot.anchorId === "aiBase") ? window.aiBase : gameState.buildings.find(b => b.id === mission.snapshot.anchorId);
        if (!anchor) { isResolved = true; rewardDelta = -2.0; reason = "ANCHOR_MISSING"; }
        else {
          const enemiesNow = gameState.units.filter(u => u.owner === "player" && u.health > 0 && Math.hypot(u.x - anchor.x, u.y - anchor.y) < 300).length;
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
          
          if (elapsed >= 30) {
            isResolved = true; rewardDelta = -2.0; reason = "DEFENSE_TIMEOUT";
          } else if (elapsed >= 10 || (enemiesAtStart > 0 && enemiesNow === 0)) {
            isResolved = true;
            if (enemiesAtStart > 0 && enemiesNow === 0 && aliveDefenders > 0) {
              const hadRealCombat = totalDamageDealt > 50 || totalDamageTaken > 30 || lostDefenders > 0;
              if (hadRealCombat) {
                const efficiency = totalDamageDealt / Math.max(1, totalDamageTaken);
                rewardDelta = Math.min(15.0, 5.0 + efficiency * 2.0);
                reason = `DEFENSE_SUCCESS`;
              } else { rewardDelta = -1.0; reason = "DEFEND_WITHOUT_COMBAT"; }
            } else if (totalDefendersAtStart > 0 && aliveDefenders === 0) {
              rewardDelta = -5.0; reason = "DEFENSE_FAILED";
            } else if (enemiesNow > 0 && aliveDefenders > 0) {
              rewardDelta = 1.0; reason = "DEFENSE_ONGOING";
            } else {
              // 🔥 УСИЛЕННЫЙ ШТРАФ: защита от НЕВИДИМОГО врага = пассивность в темноте
              const enemiesVisibleNow = this.countVisibleEnemies();
              if (enemiesVisibleNow === 0) {
                rewardDelta = -5.0;
                reason = "HIDING_IN_DARKNESS: враг невидим, надо РАЗВЕДЫВАТЬ!";
              } else {
                rewardDelta = -1.0;
                reason = "DEFENSE_NO_THREAT";
              }
            }
          }
        }
      }
      
      // 3. НАЙМ
      else if (mission.intent.type === "hire") {
        const type = mission.intent.unitType;
        const elapsed = performance.now() - mission.snapshot.time;
        const unitAppeared = gameState.units.some(u => u.owner === "ai" && u.type === type && u.health > 0 && (performance.now() - (u.builtAt || 0)) < 30000);
        
        if (unitAppeared || elapsed > 20000) {
          isResolved = true;
          if (unitAppeared) {
            const baseRewards = { "worker": 5.0, "repairman": 3.0, "fighter": 6.0, "assault": 8.0, "elite": 12.0 };
            rewardDelta = baseRewards[type] || 3.0; 
            reason = `UNIT_HIRED_SUCCESS: ${type}`;
            if (type === "worker") {
              const totalWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
              const totalWorkshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active).length;
              const neededWorkers = (totalWarehouses * 5) + (totalWorkshops * 5);
              const currentWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
              if (currentWorkers < neededWorkers) { rewardDelta += 3.0; reason += " +ЗАКРЫЛ ДЕФИЦИТ"; }
            }
          } else { rewardDelta = -1.0; reason = "HIRE_TIMEOUT"; }
        }
      }
      
      // 4. СТРОИТЕЛЬСТВО
      else if (mission.intent.type === "build") {
        const bt = mission.intent.buildingType;
        const isBuilt = gameState.buildings.some(b => b.owner === "ai" && b.type === bt && b.active);
        const elapsed = performance.now() - mission.snapshot.time;
        
        if (isBuilt || elapsed > 25000) {
          isResolved = true;
          if (isBuilt) {
            const rewards = { "warehouse": 10.0, "repairWorkshop": 6.0, "barracks": 8.0, "barracks2": 10.0, "barracks3": 12.0, "base2": 15.0, "base3": 18.0, "turret": 6.0, "turret2": 8.0, "turret3": 10.0, "beacon": 7.0 };
            rewardDelta = rewards[bt] || 5.0;
            reason = `BUILDING_BUILT: ${bt}`;
            const builtObj = gameState.buildings.find(b => b.owner === "ai" && b.type === bt && b.active);
            if (builtObj) {
              const distFromBase = Math.hypot(builtObj.x - (window.aiBase?.x || 0), builtObj.y - (window.aiBase?.y || 0));
              const scale = typeof window.getWorldScale === 'function' ? window.getWorldScale() : 1.0;
              if (distFromBase > 400 * scale) { rewardDelta += 15.0; reason += " +EXPANSION_BONUS"; }
            }
          } else { rewardDelta = -2.0; reason = "BUILD_TIMEOUT"; }
        }
      }

      // 🔥 4.5. РАЗВЕДКА (НЕПРЕРЫВНАЯ + ЦЕЛЕВАЯ)
      else if (mission.intent.type === "recon") {
        const elapsed = (performance.now() - mission.snapshot.time) / 1000;
        const unitIds = mission.intent.unitIds || [];
        const aliveRecon = unitIds.filter(id => {
          const u = gameState.units.find(x => x.id === id);
          return u && u.health > 0;
        }).length;

        // Текущие показатели видимости
        const fogNow = this.countExploredCells();
        const enemiesNow = this.countVisibleEnemies();
        const basesNow = this.countVisibleEnemyBases();
        
        const fogAtStart = mission.intent.fogCountAtStart || fogNow;
        const enemiesAtStart = mission.intent.enemiesAtStart || 0;
        const basesAtStart = mission.intent.basesAtStart || 0;

        const totalNewCells = Math.max(0, fogNow - fogAtStart);
        const newEnemies = Math.max(0, enemiesNow - enemiesAtStart);
        const newBases = Math.max(0, basesNow - basesAtStart);

        // 🔥 1. НЕПРЕРЫВНАЯ МИКРО-НАГРАДА (каждые 2 секунды)
        if (elapsed > 2 && aliveRecon > 0) {
          if (mission._lastReconTick === undefined) {
            mission._lastReconTick = 0;
            mission._lastCellCount = fogAtStart;
          }
          if (elapsed - mission._lastReconTick >= 2.0) {
            const currentCells = this.countExploredCells();
            const newCellsSinceLastTick = Math.max(0, currentCells - (mission._lastCellCount || fogAtStart));
            
            if (newCellsSinceLastTick > 0) {
              // +0.05 за каждую новую клетку! Модель поймет, что двигаться выгодно.
              mission.replayEntry.reward += newCellsSinceLastTick * 0.05; 
            }
            mission._lastCellCount = currentCells;
            mission._lastReconTick = elapsed;
          }
        }

        // 🔥 2. ЖЕСТКИЕ УСЛОВИЯ ЗАВЕРШЕНИЯ (Чтобы не останавливалась после 1 клетки)
        const MIN_RECON_TIME = 15.0;   // Минимум 15 секунд в пути
        const MIN_RECON_CELLS = 50;    // Или открыть минимум 50 клеток

        if (newBases > 0) {
          // ГЛАВНЫЙ КУШ: обнаружена вражеская база! Миссия выполнена мгновенно.
          isResolved = true;
          rewardDelta = 25.0 + (totalNewCells * 0.1);
          reason = `RECON_FOUND_BASE: база открыта! (+${totalNewCells} клеток)`;
        } 
        else if (newEnemies > 0 && elapsed > 3) {
          // Найдены вражеские юниты/здания — миссия выполнена
          isResolved = true;
          rewardDelta = 10.0 + (newEnemies * 2.0) + (totalNewCells * 0.05);
          reason = `RECON_FOUND_ENEMIES: ${newEnemies} целей, (+${totalNewCells} клеток)`;
        } 
                // 🔥 СТРАХОВКА: Если разведчики улетели слишком далеко в пустоту (далеко за пределы карты)
        const wW = typeof worldWidth !== 'undefined' ? worldWidth : 2000;
        const wH = typeof worldHeight !== 'undefined' ? worldHeight : 2000;
        let isLostInSpace = false;
        
        unitIds.forEach(id => {
          const u = gameState.units.find(x => x.id === id);
          if (u && u.health > 0) {
            // Если юнит дальше чем на 600px за пределами карты, считаем его "потерянным в космосе"
            if (u.x < -600 || u.x > wW + 600 || u.y < -600 || u.y > wH + 600) {
              isLostInSpace = true;
            }
          }
        });

        if (isLostInSpace) {
          isResolved = true;
          rewardDelta = -5.0;
          reason = "RECON_LOST_IN_SPACE: улетел слишком далеко, возвращайся!";
        }
        else if (aliveRecon === 0 && unitIds.length > 0) {
          // Все разведчики мертвы
          isResolved = true;
          rewardDelta = totalNewCells > 50 ? 3.0 : -2.0;
          reason = totalNewCells > 50 ? "RECON_DIED_BUT_EXPLORED" : "RECON_FAILED_DEAD";
        }
        else if (aliveRecon === 0 && unitIds.length > 0) {
          // Все разведчики мертвы
          isResolved = true;
          rewardDelta = totalNewCells > MIN_RECON_CELLS ? 3.0 : -2.0;
          reason = totalNewCells > MIN_RECON_CELLS ? "RECON_DIED_BUT_EXPLORED" : "RECON_FAILED_DEAD";
        } 
        else if (elapsed >= MIN_RECON_TIME) {
          // Таймаут: проверяем, достигли ли мы минимальной цели по клеткам
          isResolved = true;
          if (totalNewCells >= MIN_RECON_CELLS) {
            rewardDelta = 5.0 + (totalNewCells * 0.05);
            reason = `RECON_SUCCESS: открыто ${totalNewCells} клеток за ${elapsed.toFixed(1)}с`;
          } else {
            rewardDelta = -3.0;
            reason = `RECON_TIMEOUT_USELESS: всего ${totalNewCells} клеток (нужно ${MIN_RECON_CELLS})`;
          }
        }
        // ⚠️ ВАЖНО: Если elapsed < MIN_RECON_TIME и клеток < MIN_RECON_CELLS, 
        // isResolved остается false, и миссия ПРОДОЛЖАЕТСЯ, накапливая микро-награды!
      }
      
      // 5. БЕЗДЕЙСТВИЕ
      else if (mission.intent.type === "idle") {
        const gameTimeMin = performance.now() / 60000;
        const res = m.res || { gold: 0, silicon: 0, plasma: 0 };
        
        const canAffordWorker = (res.gold >= 4) && (res.silicon >= 6) && (res.plasma >= 3);
        const canAffordWarehouse = (res.gold >= 12) && (res.silicon >= 5) && (res.plasma >= 3);
        const canAffordBarracks = (res.gold >= 41) && (res.silicon >= 52) && (res.plasma >= 15);
        const canAffordBase2 = (res.gold >= 81) && (res.silicon >= 92) && (res.plasma >= 43);
        
        const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
        const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2" && b.active);
        const warehouseCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
        const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
        
        let criticalGoal = null;
        if (!hasBarracks && canAffordBarracks && gameTimeMin > 2.0) criticalGoal = "barracks";
        else if (!hasBase2 && hasBarracks && canAffordBase2 && gameTimeMin > 4.0) criticalGoal = "base2";
        else if (warehouseCount < 2 && canAffordWarehouse && gameTimeMin > 1.5) criticalGoal = "warehouse";
        else if (workerCount < warehouseCount * 5 && canAffordWorker && gameTimeMin > 1.0) criticalGoal = "worker";
        
        if (criticalGoal) {
          rewardDelta = -2.0; // Мягкий пинок, а не удар кувалдой
          reason = `IDLE_WHILE_CAN_BUILD: можно построить ${criticalGoal}`;
        } else {
          const totalRes = (res.gold || 0) + (res.silicon || 0) + (res.plasma || 0);
          if (totalRes > 100 && gameTimeMin > 3.0) { rewardDelta = 0.0; reason = "SAVING_FOR_EXPENSIVE_GOAL"; } 
          else { rewardDelta = 0.0; reason = "WAITING_FOR_RESOURCES"; }
        }
        if (gameTimeMin > 3.0 && m.aiArmy === 0 && (res.gold || 0) > 50) { rewardDelta -= 1.0; reason += " +NO_ARMY_PANIC"; }
        if (m.enemyNear > 0 && (res.gold || 0) > 50) { rewardDelta -= 1.0; reason += " +IDLE_UNDER_THREAT"; }
        isResolved = true;
      }

      // 🔥 ПРИМЕНЕНИЕ НАГРАДЫ (ТОЛЬКО ЗДЕСЬ ПИШЕМ В REPLAY)
      if (isResolved || rewardDelta !== 0) {
        const clippedDelta = Math.max(-50.0, Math.min(50.0, rewardDelta));
        if (isResolved) {
          mission.replayEntry.reward = clippedDelta; 
          mission.resolved = true;
        } else {
          mission.replayEntry.reward = Math.max(-10.0, Math.min(10.0, mission.replayEntry.reward + (clippedDelta * 0.1)));
        }
        
        if (window.GNN_DEBUG_REWARDS || Math.abs(clippedDelta) >= 5.0) {
          const sign = clippedDelta >= 0 ? '+' : '';
          const emoji = clippedDelta >= 5.0 ? '🟢' : (clippedDelta <= -5.0 ? '🔴' : '⚪');
          console.log(`[GnnAI ${emoji}] ${mission.action} → ${sign}${clippedDelta.toFixed(1)} | ${reason || 'no reason'}`);
        }
      }
    }
  },
  evaluateEconomyEfficiency: function (now) {
    if (!this.lastEcoEffCheck || now - this.lastEcoEffCheck < 10000) return;
    this.lastEcoEffCheck = now;
    // Эвристики можно добавить сюда, но replay.push запрещен
  },
  evaluateOpponentGap: function (now) {
    if (!this.lastGapCheck || now - this.lastGapCheck < 10000) return;
    this.lastGapCheck = now;
    // Эвристики, без replay.push
  },
  evaluateStagnation: function (now) {
    if (now - this.lastStagnationCheck < 10000) return;
    this.lastStagnationCheck = now;
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    
    // Эвристика продажи зданий при стагнации (уже реализована в evaluateBuildingLiquidation)
    this.lastArmySize = m.aiArmy;
    this.lastBuildingCount = m.aiBuildings;
    this.lastResourceTotal = m.resTotal;
  },
  evaluateMilitaryBalance: function (now) {
    if (!this.lastMilitaryCheck || now - this.lastMilitaryCheck < 10000) return;
    this.lastMilitaryCheck = now;
  },
  evaluateArmyActivity: function (now) {
    if (!this.lastArmyActivityCheck || now - this.lastArmyActivityCheck < 10000) return;
    this.lastArmyActivityCheck = now;
  },
  checkTechStagnation: function (now) {
    if (!this.lastTechStagnationCheck || now - this.lastTechStagnationCheck < 10000) return;
    this.lastTechStagnationCheck = now;
    this.lastResourceTotal = this.metrics().resTotal;
  },
  evaluatePhaseRewards: function (now) {
    if (!this.lastPhaseCheck || now - this.lastPhaseCheck < 10000) return;
    this.lastPhaseCheck = now;
  },
  evaluateResourceControl: function (now) {
    if (!this.lastResourceControlCheck || now - this.lastResourceControlCheck < 5000) return;
    this.lastResourceControlCheck = now;
  },
  evaluateExpansion: function (now) {
    if (!this.lastExpansionCheck || now - this.lastExpansionCheck < 5000) return;
    this.lastExpansionCheck = now;
  },
  evaluateCombatEfficiency: function (now) {
    if (!this.lastCombatEfficiencyCheck || now - this.lastCombatEfficiencyCheck < 6000) return;
    this.lastCombatEfficiencyCheck = now;
    const m = this.metrics();
    let currentDamageDealt = 0, currentDamageTaken = 0, killedEnemies = 0, lostAllies = 0;
    this.missionCache.forEach(mission => {
      if (mission.resolved || mission.intent.type !== "attack") return;
      (mission.intent.unitIds || []).forEach(id => {
        const u = gameState.units.find(x => x.id === id);
        if (u && u.missionLog) {
          currentDamageDealt += u.missionLog.damageDealt || 0;
          currentDamageTaken += u.missionLog.damageTaken || 0;
          if (!u.missionLog.alive) lostAllies++;
          killedEnemies += (u.missionLog.events || []).filter(e => e.type === "target_destroyed" && e.to && e.to.owner === "player").length;
        }
      });
    });
    this._lastDamageDealt = currentDamageDealt;
    this._lastDamageTaken = currentDamageTaken;
    this._lastKillCount = killedEnemies;
    this._lastDeathCount = lostAllies;
  },
  evaluateTargetSelection: function (now) {
    if (!this.lastTargetSelectionCheck || now - this.lastTargetSelectionCheck < 8000) return;
    this.lastTargetSelectionCheck = now;
  },
  evaluateArmyPreservation: function (now) {
    if (!this.lastArmyPreservationCheck || now - this.lastArmyPreservationCheck < 8000) return;
    this.lastArmyPreservationCheck = now;
  },
  evaluateRecon: function (now) {
    if (!this.lastReconCheck || now - this.lastReconCheck < 3000) return;
    this.lastReconCheck = now;
  },
  evaluateReconDiscovery: function (now) {
    if (!this.lastReconDiscoveryCheck || now - this.lastReconDiscoveryCheck < 2000) return;
    this.lastReconDiscoveryCheck = now;
  },
  evaluateStrategicAdaptation: function (now) {
    if (!this.lastAdaptationCheck || now - this.lastAdaptationCheck < 15000) return;
    this.lastAdaptationCheck = now;
    const currentEnemyComp = this.strategicMemory.enemyComposition || {};
    const isEnemyAggressive = (currentEnemyComp.fighter || 0) > (currentEnemyComp.worker || 0);
    const wasEnemyAggressive = this.strategicMemory.wasEnemyAggressive || false;
    if (isEnemyAggressive !== wasEnemyAggressive) {
      this.strategicMemory.wasEnemyAggressive = isEnemyAggressive;
    }
  },
  evaluateBuildingLiquidation: function(now) {
    if (!this.lastLiquidationCheck || now - this.lastLiquidationCheck < 4000) {
      this.lastLiquidationCheck = now;
    } else {
      return;
    }
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    const aiBuildings = gameState.buildings.filter(b => b.owner === "ai" && b.health > 0 && b.active);
    const aiWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0);
    const protectedTypes = ["base", "base2", "base3"];

    // 1. Награда за умное восстановление (эвристика, можно оставить, но лучше перенести в evaluateMissions при событии продажи)
    // Для простоты оставим только логику queueSale, а награду дадим через evaluateMissions при типе 'sell' (если он есть) или игнорируем здесь replay.
    
    if (aiWorkers.length === 0 && gameTimeMin > 1.5) {
      const uselessEconomy = aiBuildings.filter(b => b.type === "warehouse" || b.type === "repairWorkshop").length;
      if (uselessEconomy > 1) {
        const toSell = aiBuildings.filter(b => b.type === "warehouse").sort((a,b) => a.health - b.health)[0];
        if (toSell && typeof queueSale === "function" && !toSell.isSelling) queueSale(toSell);
      }
    }

    const criticalUnrepaired = aiBuildings.filter(b => !protectedTypes.includes(b.type) && b.health < b.maxHealth * 0.3 && (!b.repairmen || b.repairmen.length === 0) && (!b.productionQueue || b.productionQueue.length === 0));
    if (criticalUnrepaired.length > 0) {
      const worstBuilding = criticalUnrepaired.sort((a, b) => a.health - b.health)[0];
      if (typeof queueSale === "function" && !worstBuilding.isSelling) queueSale(worstBuilding);
    }

    const turrets = aiBuildings.filter(b => b.type.startsWith("turret"));
    if (turrets.length >= 4 && m.aiArmy === 0 && gameTimeMin > 3.0) {
      const cheapestTurret = turrets.sort((a, b) => {
        const costA = (a.buildCost?.gold || 0) + (a.buildCost?.silicon || 0);
        const costB = (b.buildCost?.gold || 0) + (b.buildCost?.silicon || 0);
        return costA - costB;
      })[0];
      if (cheapestTurret && typeof queueSale === "function" && !cheapestTurret.isSelling) queueSale(cheapestTurret);
    }
    // replay.push УДАЛЕН ОТСЮДА
  }
});