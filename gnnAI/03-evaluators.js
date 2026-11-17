// ============================================================
// 03-evaluators.js — Все оценщики: evaluate*, checkTechStagnation,
//                    checkEconomicParalysis, evaluatePhaseRewards
// ============================================================
"use strict";

Object.assign(window.GnnAI, {

  // === Экономический паралич ===
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
        this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: this._AIDX.idle, reward: -5.0 });
      }
    }
  },

  // === Миссии ===
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
          let resolved = false;
          let tacticReward = 0;
          let eventReason = "";

          if (alive.length === 0 && dead.length > 0) {
            resolved = true;
            if (completed.length > 0) {
              const baseReward = targetImportance >= 50 ? 30.0 : 10.0;
              tacticReward = baseReward + totalDamageDealt * 0.1;
              eventReason = `HEROIC_SACRIFICE: все погибли, но ${targetType} уничтожена (важность: ${targetImportance})`;
            } else if (reached.length > 0) {
              tacticReward = -5.0 + totalDamageDealt * 0.05;
              eventReason = "REACHED_BUT_DIED: дошли до цели, но не уничтожили";
            } else if (diedToTurret) {
              tacticReward = -20.0;
              eventReason = "DIED_TO_TURRETS: попали под турели, не достигнув цели";
            } else {
              tacticReward = -10.0;
              eventReason = "TOTAL_WIPEOUT: армия уничтожена без результата";
            }
          } else if (completed.length === logs.length && alive.length === logs.length) {
            resolved = true;
            let baseReward = 0;
            if (targetImportance >= 80) baseReward = 80.0;
            else if (targetImportance >= 50) baseReward = 40.0;
            else if (targetImportance >= 30) baseReward = 20.0;
            else baseReward = 10.0;
            tacticReward = baseReward + totalDamageDealt * 0.25;
            eventReason = `PERFECT_STRIKE: все вернулись, ${targetType} уничтожена (важность: ${targetImportance}, база: ${baseReward})`;
          } else if (completed.length > 0) {
            resolved = true;
            const lossRatio = dead.length / logs.length;
            let baseReward = 0;
            if (targetImportance >= 80) baseReward = 50.0;
            else if (targetImportance >= 50) baseReward = 30.0;
            else if (targetImportance >= 30) baseReward = 15.0;
            else baseReward = 5.0;
            tacticReward = baseReward - lossRatio * 15.0 + totalDamageDealt * 0.15;
            eventReason = `TARGET_KILLED_LOSS_${Math.round(lossRatio*100)}%: потери ${dead.length}/${logs.length}, ${targetType} (важность: ${targetImportance})`;
          } else if (reached.length > 0 && alive.length > 0) {
            // ИСПРАВЛЕНО: Поощряем юнитов за то, что они держат позицию и наносят урон, а не дергаются
            const elapsed = (performance.now() - mission.snapshot.time) / 1000;
            if (elapsed > 5 && totalDamageDealt > 20) {
              tacticReward = 2.0 + (totalDamageDealt * 0.05); // Мягкий положительный дрейф
              eventReason = "HOLDING_POSITION_AND_DEALING_DAMAGE";
            } else {
              tacticReward = totalDamageDealt * 0.05;
              eventReason = "IN_PROGRESS: бой идёт";
            }
          }  else if (alive.length === logs.length && reached.length === 0) {
            const stuckTime = (performance.now() - mission.snapshot.time) / 1000;
            if (stuckTime > 20) {
              resolved = true;
              tacticReward = -15.0;
              eventReason = `STUCK_NO_PROGRESS: ${stuckTime.toFixed(0)}с без достижения цели`;
            }
          }

          if (resolved) {
            const noClusterDamage = logs.every(l => l.damageTaken < 50);
            if (mission.snapshot.enemyClusterNear && noClusterDamage && completed.length > 0) {
              tacticReward += 25.0;
              eventReason += " +CLEVER_FLANK";
            }
            if (diedToTurret && dead.length > 0) {
              tacticReward -= 15.0;
              eventReason += " +FRONTAL_TURRET_ASSAULT";
            }
            if (mission.snapshot.targetStartHP && mission.snapshot.targetStartHP < 100 && completed.length > 0) {
              tacticReward += 10.0;
              eventReason += " +FINISHING_BLOW";
            }
            const efficiency = totalDamageDealt / Math.max(1, totalDamageTaken);
            if (efficiency > 3 && completed.length > 0 && targetImportance >= 50) {
              tacticReward += 15.0;
              eventReason += ` +EFFICIENT_${efficiency.toFixed(1)}x`;
            }
            if (target && completed.length > 0) {
              tacticReward += targetImportance;
              eventReason += ` +${targetType.toUpperCase()}_DESTROYED`;
            }
            if (targetType === "worker" && completed.length > 0) {
              tacticReward -= 5.0;
              eventReason += " +WORKER_HARASS_PENALTY";
            }
            if (mission.replayEntry) {
              mission.replayEntry.tacticalContext = {
                totalDamageDealt, totalDamageTaken,
                lossRatio: dead.length / Math.max(1, logs.length),
                hitByTurret, completedMission: completed.length > 0,
                efficiency: totalDamageDealt / Math.max(1, totalDamageTaken),
                targetImportance
              };
            }
            for (const uid of unitIds) {
              const u = gameState.units.find(x => x.id === uid);
              if (u && u.missionLog) u.missionLog = null;
            }
            const missionTime = (performance.now() - mission.snapshot.time) / 1000;
            if (missionTime < 15 && completed.length > 0) {
              tacticReward += 20.0;
              eventReason += " +BLITZ_EXECUTION";
            }
            if (completed.length > 0 && logs.length <= 3 && totalDamageDealt > 200 && targetImportance >= 50) {
              tacticReward += 25.0;
              eventReason += " +ELITE_SQUAD";
            }
          }
          rewardDelta += tacticReward;
          reason = eventReason;
          isResolved = resolved;
        }
      }
      // 2. ЗАЩИТА
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
        const missionDuration = (performance.now() - mission.snapshot.time) / 1000;
        const unitIds = mission.intent.unitIds || [];
        const logs = unitIds.map(id => {
          const u = gameState.units.find(x => x.id === id);
          return u ? u.missionLog : null;
        }).filter(Boolean);
        const totalDamageDealt = logs.reduce((s, l) => s + (l.damageDealt || 0), 0);
        const totalDamageTaken = logs.reduce((s, l) => s + (l.damageTaken || 0), 0);
        const lostDefenders = totalDefendersAtStart - aliveDefenders;

        if (enemiesAtStart > 0 && enemiesNearAnchorNow === 0 && aliveDefenders > 0) {
          const hadRealCombat = totalDamageDealt > 50 || totalDamageTaken > 30 || lostDefenders > 0;
          if (hadRealCombat) {
            const efficiency = totalDamageDealt / Math.max(1, totalDamageTaken);
            const combatReward = Math.min(60.0, 20.0 + efficiency * 10.0 + lostDefenders * 5.0);
            rewardDelta = combatReward;
            reason = `successful_defense_OUTCOME: урон ${totalDamageDealt.toFixed(0)}, потери ${lostDefenders}, эффективность ${efficiency.toFixed(2)}`;
            isResolved = true;
          } else {
            rewardDelta = -10.0;
            reason = "DEFEND_WITHOUT_COMBAT: защитники не вступили в бой";
            isResolved = true;
          }
        } else if (enemiesAtStart === 0 && enemiesNearAnchorNow === 0) {
          const recentEnemyPresence = gameState.units.some(u =>
            u.owner === "player" && u.health > 0 && anchor &&
            Math.hypot(u.x - anchor.x, u.y - anchor.y) < 500
          );
          if (recentEnemyPresence) {
            rewardDelta = 5.0;
            reason = "PREVENTIVE_DEFENSE: враг был рядом, но ушёл";
            isResolved = true;
          } else {
            rewardDelta = -30.0;
            reason = "defending_nothing_penalty: врага нет и не было";
            isResolved = true;
          }
        } else if (totalDefendersAtStart > 0 && aliveDefenders === 0) {
          rewardDelta = -60.0;
          reason = "all_defenders_lost_OUTCOME";
          isResolved = true;
        } else if (enemiesNearAnchorNow > 0 && aliveDefenders > 0) {
          rewardDelta = 0.5 + (totalDamageDealt > 0 ? 0.3 : 0);
        }
      }
      // 3. НАЙМ
      else if (mission.intent.type === "hire") {
        if (this.metrics().aiArmy > mission.snapshot.aiArmy || mission.intent.unitType === "worker" || mission.intent.unitType === "repairman") {
          const type = mission.intent.unitType;
          let hireReward = 0;
          const totalWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
          const totalWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
          const totalWorkshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active).length;
          const neededWorkers = totalWarehouses * 3 + totalWorkshops * 2;
          if (type === "worker") {
            if (totalWorkers < neededWorkers) { hireReward = 8.0; reason = "worker_filled_deficit"; }
            else { hireReward = 1.0; reason = "worker_hired"; }
          } else if (type === "repairman") { hireReward = 2.0; reason = "repairman_hired"; }
          else if (type === "fighter") { hireReward = (m.aiArmy === 0) ? 15.0 : 2.0; reason = m.aiArmy === 0 ? "FIRST_BLOOD_UNIT_HIRED" : "fighter_hired"; }
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
      // 4. СТРОИТЕЛЬСТВО
      else if (mission.intent.type === "build") {
        const bt = mission.intent.buildingType;
        const isBuilt = gameState.buildings.some(b => b.owner === "ai" && b.type === bt && b.active);
        if (isBuilt) {
          const prev = mission.snapshot;
          let reasonBuild = "";
          if (bt === "warehouse" || bt === "repairWorkshop") {
            const totalWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
            const totalWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
            const totalWorkshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active).length;
            const neededWorkers = totalWarehouses * 3 + totalWorkshops * 2;
            const gameTimeMin = performance.now() / 60000;
            const emptyWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) === 0).length;
            if (totalWorkers < neededWorkers) {
              const deficit = neededWorkers - totalWorkers;
              rewardDelta -= 15.0 * deficit;
              reasonBuild = `WORKER_DEFICIT_CRITICAL: не хватает ${deficit} рабочих, ${emptyWarehouses} складов пустуют!`;
            } else if (emptyWarehouses > 0 && gameTimeMin > 1.5) {
              rewardDelta -= 12.0 * emptyWarehouses;
              reasonBuild = `EMPTY_WAREHOUSES_PENALTY: ${emptyWarehouses} складов без рабочих!`;
            } else {
              rewardDelta += 3.0;
              reasonBuild = "INFRASTRUCTURE_WITH_WORKERS";
            }
          } else if (this.BUILD_BONUSES[bt] !== undefined) {
            rewardDelta += this.BUILD_BONUSES[bt];
            if (this.BUILD_TIER_GOALS[bt]) this.tierGoalsMet[this.BUILD_TIER_GOALS[bt]] = true;
            reasonBuild = bt.toUpperCase() + "_BUILT";
          } else if (bt.startsWith("turret")) {
            rewardDelta += 15.0;
            reasonBuild = "TURRET_BUILT";
            const builtObj = gameState.buildings.find(b => b.owner === "ai" && b.type === bt && b.active);
            if (builtObj) {
              const nearBeacon = gameState.buildings.some(b => b.owner === "ai" && b.type === "beacon" && Math.hypot(b.x - builtObj.x, b.y - builtObj.y) < 250);
              const nearBase = Math.hypot(builtObj.x - aiBase.x, builtObj.y - aiBase.y) < 400;
              if (nearBeacon) { rewardDelta += 25.0; reasonBuild += "_FORT_TURRET_BUILT"; }
              else if (!nearBase) { rewardDelta -= 20.0; reasonBuild += "_TURRET_IN_VOID_PENALTY"; }
            }
          } else if (bt === "beacon") {
            const beaconCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.active).length;
            const newBeacon = gameState.buildings.find(b => b.owner === "ai" && b.type === "beacon" && b.active && !b.rewarded);
            let sectorScore = 0;
            if (newBeacon) {
              if (gameState.buildings.some(b => b.owner === "ai" && b.type === "warehouse" && b.active && Math.hypot(b.x - newBeacon.x, b.y - newBeacon.y) < 250)) sectorScore += 1;
              if (gameState.buildings.some(b => b.owner === "ai" && b.type.startsWith("turret") && b.active && Math.hypot(b.x - newBeacon.x, b.y - newBeacon.y) < 250)) sectorScore += 1;
              if (gameState.resources.some(r => r.amount > 20 && Math.hypot(r.x - newBeacon.x, r.y - newBeacon.y) < 300)) sectorScore += 1;
              if (gameState.units.some(u => u.owner === "ai" && u.type === "worker" && u.health > 0 && Math.hypot(u.x - newBeacon.x, u.y - newBeacon.y) < 300)) sectorScore += 1;
              newBeacon.rewarded = true;
            }
            if (beaconCount > 3) { rewardDelta -= 40.0; reasonBuild = "BEACON_SPAM_CRITICAL"; }
            else if (sectorScore === 4) { rewardDelta += 50.0; reasonBuild = "PERFECT_SECTOR_COMPLETE"; }
            else if (sectorScore === 3) { rewardDelta += 30.0; reasonBuild = "SECTOR_ALMOST_COMPLETE"; }
            else if (sectorScore === 2) { rewardDelta += 15.0; reasonBuild = "SECTOR_PARTIAL"; }
            else if (sectorScore === 1) { rewardDelta += 5.0; reasonBuild = "SECTOR_STARTED"; }
            else { rewardDelta -= 25.0; reasonBuild = "BEACON_IN_VOID_PENALTY"; }
          } else {
            rewardDelta += 5.0;
            reasonBuild = "building_bonus";
          }
          if (["warehouse","repairWorkshop","turret","turret2","turret3"].includes(bt)) {
            const builtObj = gameState.buildings.find(b => b.owner === "ai" && b.type === bt && b.active);
            if (builtObj) {
              const nearBeacon = gameState.buildings.some(b => b.owner === "ai" && b.type === "beacon" && Math.hypot(b.x - builtObj.x, b.y - builtObj.y) < 220);
              if (nearBeacon) {
                if (bt.startsWith("turret")) { rewardDelta += 40.0; reasonBuild += "_FORT_TURRET_BUILT"; }
                else { rewardDelta += 25.0; reasonBuild += "_CLUSTER_ON_OUTPOST"; }
              }
            }
          }
          if (bt === "warehouse" && m.aiWarehouses > 5) { rewardDelta -= 2.0; reasonBuild += "_DIMINISHING"; }
          if (bt === "repairWorkshop") {
            const workshops = gameState.buildings.filter(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active).length;
            if (workshops > 2) { rewardDelta -= 10.0; reasonBuild = "REPAIR_WORKSHOP_SPAM: 3+ мастерских без необходимости!"; }
          } else if (["warehouse","repairWorkshop"].includes(bt)) {
            if (m.aiArmy > prev.aiArmy || m.resTotal < prev.resTotal) { rewardDelta += 3.0; reasonBuild = "eco_utilized"; }
            else { rewardDelta -= 1.0; reasonBuild = "eco_stagnation"; }
          }
          if (["warehouse","repairWorkshop","turret","turret2","turret3","barracks","barracks2","barracks3"].includes(bt)) {
            const builtObj = gameState.buildings.find(b => b.owner === "ai" && b.type === bt && b.active);
            if (builtObj) {
              const distFromBase = Math.hypot(builtObj.x - aiBase.x, builtObj.y - aiBase.y);
              if (distFromBase > 400) {
                const expansionBonus = Math.min(20.0, (distFromBase - 400) / 50);
                rewardDelta += expansionBonus;
                reasonBuild += `_EXPANSION_BONUS_${expansionBonus.toFixed(1)}`;
              }
            }
          }
          rewardDelta = Math.round(rewardDelta * 10) / 10;
          reason = `build_consequence_${reasonBuild}`;
          isResolved = true;
        } else {
          const elapsed = performance.now() - mission.snapshot.time;
          if (elapsed > 30000) { rewardDelta = -5.0; reason = "build_timeout"; isResolved = true; }
        }
      }
      // 5. БЕЗДЕЙСТВИЕ
      else if (mission.intent.type === "idle") {
        const gameTimeMin = performance.now() / 60000;
        const totalResRaw = (m.res.gold || 0) + (m.res.silicon || 0) + (m.res.plasma || 0);
        const costBase2 = (typeof BASE2_COST !== 'undefined') ? (BASE2_COST.gold + BASE2_COST.silicon + BASE2_COST.plasma) : 200;
        const costBarracks2 = (typeof BARRACKS2_COST !== 'undefined') ? (BARRACKS2_COST.gold + BARRACKS2_COST.silicon + BARRACKS2_COST.plasma) : 150;
        const costExpansion = (typeof BEACON_COST !== 'undefined') ? (BEACON_COST.gold + BEACON_COST.silicon + BEACON_COST.plasma + WAREHOUSE_COST.gold + WAREHOUSE_COST.silicon + WAREHOUSE_COST.plasma + WORKER_COST.gold * 2) : 100;
        const hasBarracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks" && b.active);
        const hasBase2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base2" && (b.active || (b.builtAt && !b.active)));
        const hasBarracks2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks2" && b.active);
        const warehouseCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
        const workerCount = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
        let criticalGoalCost = 9999;
        let criticalGoalName = "none";
        if (!hasBarracks && gameTimeMin > 1.5) {
          criticalGoalCost = (typeof BARRACKS_COST !== 'undefined') ? (BARRACKS_COST.gold + BARRACKS_COST.silicon + BARRACKS_COST.plasma) : 100;
          criticalGoalName = "barracks";
        } else if (!hasBase2 && hasBarracks && gameTimeMin > 3.0) {
          criticalGoalCost = costBase2;
          criticalGoalName = "base2";
        } else if (warehouseCount < 2 && gameTimeMin > 1.0) {
          criticalGoalCost = (typeof WAREHOUSE_COST !== 'undefined') ? (WAREHOUSE_COST.gold + WAREHOUSE_COST.silicon + WAREHOUSE_COST.plasma) : 50;
          criticalGoalName = "warehouse";
        } else if (workerCount < warehouseCount * 3 && gameTimeMin > 1.0) {
          criticalGoalCost = (typeof WORKER_COST !== 'undefined') ? (WORKER_COST.gold + WORKER_COST.silicon + WORKER_COST.plasma) : 20;
          criticalGoalName = "worker";
        }
        const canBuildSomething = totalResRaw >= criticalGoalCost * 0.8;
        if (canBuildSomething && criticalGoalName !== "none") {
          rewardDelta = -10.0;
          reason = `HOARDING_CRITICAL: Ресурсов хватает на ${criticalGoalName} (${totalResRaw.toFixed(0)}/${criticalGoalCost.toFixed(0)}), но ИИ бездействует!`;
        } else if (totalResRaw >= criticalGoalCost * 0.6 && criticalGoalName !== "none") {
          rewardDelta = -3.0;
          reason = `NEAR_CRITICAL_GOAL: Почти накопили на ${criticalGoalName} (${totalResRaw.toFixed(0)}/${criticalGoalCost.toFixed(0)})`;
        } else if (totalResRaw > 30 && criticalGoalName === "none") {
          rewardDelta = 1.0;
          reason = "STRATEGIC_SAVING: Копим на экспансию (нет критических целей)";
        } else {
          rewardDelta = 0.0;
          reason = "WAITING_FOR_RESOURCES: Законный простой, копим с нуля";
        }
        if (gameTimeMin > 3.0 && m.aiArmy === 0 && totalResRaw > 100) {
          rewardDelta -= 5.0;
          reason += " + NO_ARMY_PANIC: 3+ минуты без армии при ресурсах > 100!";
        }
        if (m.enemyNear > 0 && totalResRaw > 50) {
          rewardDelta -= 8.0;
          reason += " + IDLE_UNDER_THREAT: Враг рядом, а ИИ бездействует!";
        }
        isResolved = true;
      }

      // 6. Применение награды
      if (isResolved || rewardDelta !== 0) {
        const clippedDelta = Math.max(-200.0, Math.min(200.0, rewardDelta));
        mission.replayEntry.reward += clippedDelta;
        if (Math.abs(clippedDelta) > 1.0 || reason.includes("OUTCOME") || reason.includes("penalty")) {
          //console.log(`[GnnAI Cache] 🎯 '${mission.action}' → ${clippedDelta >= 0 ? '+' : ''}${clippedDelta.toFixed(2)} (${reason})`);
        }
        if (isResolved) mission.resolved = true;
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
    const woundedUnits = gameState.units.filter(u => u.owner === "ai" && u.health > 0 && u.health < u.maxHealth * 0.5).length;
    if (repairmen > 0 && woundedUnits > 0 && repairmen >= Math.ceil(woundedUnits / 3)) {
      let healingUnits = 0;
      const woundedCombatUnits = gameState.units.filter(u =>
        u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) &&
        u.health > 0 && u.health < u.maxHealth * 0.7
      );
      const workshops = gameState.buildings.filter(b =>
        b.owner === "ai" && b.type === "repairWorkshop" && b.active
      );
      woundedCombatUnits.forEach(u => {
        const nearWorkshop = workshops.some(w => Math.hypot(u.x - w.x, u.y - w.y) < 200);
        if (nearWorkshop) healingUnits++;
      });
      if (healingUnits >= Math.ceil(woundedCombatUnits.length * 0.5)) {
        const healingBonus = Math.min(2.0, healingUnits * 0.5);
        penalty += healingBonus;
        reasons.push(`REPAIR_COVERING_WOUNDED: ${healingUnits}/${woundedCombatUnits.length} раненых лечатся (+${healingBonus.toFixed(1)})`);
      } else if (woundedCombatUnits.length >= 3 && gameTimeMin > 2.0) {
        penalty -= 5.0;
        reasons.push(`AVOIDING_COMBAT: ${woundedCombatUnits.length} раненых, но только ${healingUnits} лечатся!`);
      }
    }
    const optimalRepairmen = Math.ceil(woundedUnits / 3);
    if (repairmen > optimalRepairmen + 2 && repairmen > 3) {
      const excessRepairmen = repairmen - optimalRepairmen;
      const repairSpamPenalty = -3.0 * Math.min(5, excessRepairmen);
      penalty += repairSpamPenalty;
      reasons.push(`REPAIR_SPAM: ${repairmen} ремонтников, но нужно только ${optimalRepairmen} (штраф ${repairSpamPenalty.toFixed(1)})`);
    }
    if (m.resTotal > 0.15 && m.aiArmy === this.lastArmySize && m.aiBuildings === this.lastBuildingCount) {
      penalty -= 2.0;
      reasons.push("resource_hoarding_without_investment");
    }
    const turretCount = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0).length;
    if (m.aiTurrets >= 4 && m.aiArmy < 3 && gameTimeMin > 4) {
      penalty -= 25.0;
      reasons.push("TURTLE_STRATEGY_CRITICAL: 4+ турели, но <3 бойцов после 4 мин!");
    }
    if (turretCount >= 2 && m.aiArmy === 0 && gameTimeMin > 3) {
      penalty -= 15.0;
      reasons.push("TURTLE_LITE: есть турели, но НЕТ армии после 3 мин!");
    }
    if (turretCount >= 5 && m.aiArmy < 5 && gameTimeMin > 5) {
      penalty -= 40.0;
      reasons.push("FULL_TURTLE_PENALTY: 5+ турелей, но <5 бойцов после 5 мин!");
    }
    const recentAttacks = this.missionCache.filter(m => !m.resolved && m.intent.type === "attack").length;
    const completedAttacks = this.episodeReport?.actions?.attack_front ||
      this.episodeReport?.actions?.strike_weak ||
      this.episodeReport?.actions?.focus_fire ||
      this.episodeReport?.actions?.flank_attack || 0;
    if (gameTimeMin > 3.0 && m.aiArmy >= 2 && recentAttacks === 0 && completedAttacks === 0) {
      penalty -= 20.0;
      reasons.push("NO_ATTACKS_PENALTY: армия есть, но атак НЕТ после 3 мин!");
    }
    if (gameTimeMin > 5.0 && m.aiArmy >= 3 && completedAttacks === 0) {
      penalty -= 30.0;
      reasons.push("ZERO_ATTACKS_5MIN: 5 минут без единой атаки!");
    }
    if (gameTimeMin > 5 && m.techLevel === 1) {
      penalty -= 5;
      reasons.push("tech_stagnation_tier1");
    }
    if (m.aiArmy > this.lastArmySize && m.resTotal < 150) {
      penalty += 2.0;
      reasons.push("healthy_economy_to_military_conversion");
    }
    if (m.resTotal > 0.5 && m.aiArmy < 10) {
      penalty -= 15.0;
      reasons.push("CRITICAL_HOARDING: Богат (>1000 рес), но беззащитен!");
    }
    const emptyWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) === 0).length;
    if (emptyWarehouses > 0 && gameTimeMin > 1.0) {
      const canAffordWorkers = (m.res.gold || 0) >= (WORKER_COST.gold || 0) &&
        (m.res.silicon || 0) >= (WORKER_COST.silicon || 0) &&
        (m.res.plasma || 0) >= (WORKER_COST.plasma || 0);
      if (canAffordWorkers) {
        const emptyPenalty = -10.0 * emptyWarehouses;
        penalty += emptyPenalty;
        reasons.push(`EMPTY_WAREHOUSES: ${emptyWarehouses} складов простаивают без рабочих! (штраф ${emptyPenalty})`);
      } else {
        reasons.push(`EMPTY_WAREHOUSES_BUT_NO_RESOURCES: ${emptyWarehouses} складов без рабочих, но нет ресурсов на найм (штраф пропущен)`);
      }
    }
    const aiBuildings = gameState.buildings.filter(b => b.owner === "ai" && b.health > 0);
    if (aiBuildings.length > 5) {
      let totalDist = 0;
      let pairCount = 0;
      for (let i = 0; i < Math.min(aiBuildings.length, 10); i++) {
        for (let j = i + 1; j < Math.min(aiBuildings.length, 10); j++) {
          totalDist += Math.hypot(aiBuildings[i].x - aiBuildings[j].x, aiBuildings[i].y - aiBuildings[j].y);
          pairCount++;
        }
      }
      const avgDist = pairCount > 0 ? totalDist / pairCount : 0;
      if (avgDist < 150) {
        const clusteringPenalty = -150.0 * (1 - avgDist / 150);
        penalty += clusteringPenalty;
        reasons.push(`CLUSTERING_PENALTY: Здания слишком близко друг к другу (среднее ${avgDist.toFixed(0)}px, штраф ${clusteringPenalty.toFixed(1)})`);
      }
    }
    if (turretCount >= 3 && completedAttacks < 2 && gameTimeMin > 4) {
      const passivityPenalty = -10.0 * (turretCount - 2);
      penalty += passivityPenalty;
      reasons.push(`DEFENSIVE_PASSIVITY: ${turretCount} турелей, но только ${completedAttacks} атак (штраф ${passivityPenalty.toFixed(1)})`);
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
        if (penalty < 0) {
          //console.warn(`[GnnAI] ⚠️ Обнаружен тупик: ${penalty.toFixed(1)} (${reasons.join(', ')})`);
        } else {
          //console.log(`[GnnAI] ✅ Стагнация: +${penalty.toFixed(1)} (${reasons.join(', ')})`);
        }
      }
    }
    const beaconsCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.health > 0).length;
    if (beaconsCount >= 2 && m.aiArmy < 3 && m.enemyNear > 0) {
      penalty -= 15.0;
      reasons.push("FOOLISH_EXPANSION: Построен маяк, но нечем его защитить от врага!");
    }
    const gameTimeMin2 = performance.now() / 60000;
    const idleActionCount = (this.episodeReport?.actions?.idle || 0);
    if (idleActionCount > 10 && m.resTotal > 0.2 && gameTimeMin2 > 3) {
      const idlePenalty = -3.0 * Math.min(5, Math.floor(idleActionCount / 10));
      penalty += idlePenalty;
      reasons.push(`IDLE_SPAM: ${idleActionCount} бездействий при ресурсах ${m.resTotal.toFixed(2)} (штраф ${idlePenalty.toFixed(1)})`);
    }
    this.lastArmySize = m.aiArmy;
    this.lastBuildingCount = m.aiBuildings;
    this.lastResourceTotal = m.resTotal;
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
    if (gameTimeMin > 3 && buildingCount > 14 && powerPerBuilding < 30) {
      reward -= 12.0;
      reasons.push(`BLOATED_INFRASTRUCTURE: ${buildingCount} зданий, сила/здание=${powerPerBuilding.toFixed(0)} < 30. Меньше зданий, больше армии!`);
    }
    if (this.lastBuildingCount > 0 && buildingCount <= this.lastBuildingCount) {
      const armyGrew = m.aiArmy > this.lastArmySize;
      const techGrew = m.techLevel > (this.lastTechLevel || 1);
      if (armyGrew || techGrew) {
        reward += 10.0;
        reasons.push(`EFFICIENT_CONVERSION: зданий ${buildingCount} (не +), но армия/тех выросли (+10)`);
      }
    }
    const beaconCount = gameState.buildings.filter(b => b.owner === "ai" && b.type === "beacon" && b.active).length;
    if (beaconCount > 2) {
      const excess = beaconCount - 2;
      reward -= 8.0 * excess;
      reasons.push(`BEACON_OVERBUILD: ${beaconCount} маяков, штраф -${(8.0 * excess).toFixed(0)} (лишние после 2-го)`);
    }
    this.lastTechLevel = m.techLevel;
    if (reward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: this._AIDX.idle, reward });
        if (reward < 0) console.warn(`[GnnAI] 💸 Неэффективная экономика: ${reward} (${reasons.join(', ')})`);
        else console.log(`[GnnAI] ✅ Экономия ресурсов: +${reward} (${reasons.join(', ')})`);
      }
    }
  },

  // === Контроль ресурсов ===
  evaluateResourceControl: function (now) {
    if (!this.lastResourceControlCheck || now - this.lastResourceControlCheck < 5000) return;
    this.lastResourceControlCheck = now;
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let reward = 0;
    let reasons = [];
    const allResources = gameState.resources.filter(r => r.amount > 0);
    if (allResources.length === 0) return;
    const myWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active);
    let myCoveredResources = 0, myCoveredValue = 0;
    let playerCoveredResources = 0, playerCoveredValue = 0;
    let neutralResources = 0, neutralValue = 0;
    const playerWarehouses = gameState.buildings.filter(b => b.owner === "player" && b.type === "warehouse" && b.active);
    allResources.forEach(r => {
      const value = r.amount || 0;
      const myCover = myWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
      const playerCover = playerWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
      if (myCover) { myCoveredResources++; myCoveredValue += value; }
      else if (playerCover) { playerCoveredResources++; playerCoveredValue += value; }
      else { neutralResources++; neutralValue += value; }
    });
    const totalValue = myCoveredValue + playerCoveredValue + neutralValue;
    const myShare = totalValue > 0 ? myCoveredValue / totalValue : 0;
    const playerShare = totalValue > 0 ? playerCoveredValue / totalValue : 0;
    if (myShare > 0.5) {
      const dominanceReward = 15.0 * myShare;
      reward += dominanceReward;
      reasons.push(`RESOURCE_DOMINANCE: контролируем ${(myShare * 100).toFixed(0)}% ресурсов (+${dominanceReward.toFixed(1)})`);
    } else if (myShare > 0.3) {
      reward += 8.0;
      reasons.push(`GOOD_RESOURCE_CONTROL: контролируем ${(myShare * 100).toFixed(0)}% ресурсов`);
    } else if (myShare > 0.15) {
      reward += 3.0;
      reasons.push(`WEAK_RESOURCE_CONTROL: только ${(myShare * 100).toFixed(0)}% под контролем`);
    } else if (gameTimeMin > 3.0) {
      reward -= 10.0;
      reasons.push(`NO_RESOURCE_CONTROL: контролируем только ${(myShare * 100).toFixed(0)}% ресурсов! Строй склады!`);
    }
    if (playerShare > myShare * 1.5 && gameTimeMin > 2.0) {
      const gapPenalty = -12.0 * (playerShare - myShare);
      reward += gapPenalty;
      reasons.push(`RESOURCE_GAP: враг контролирует ${(playerShare * 100).toFixed(0)}%, мы ${(myShare * 100).toFixed(0)}% (штраф ${gapPenalty.toFixed(1)})`);
    }
    if (neutralValue > 0 && myWarehouses.length > 0) {
      const expandableResources = allResources.filter(r => {
        const myCover = myWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
        const playerCover = playerWarehouses.some(w => Math.hypot(w.x - r.x, w.y - r.y) < 320);
        return !myCover && !playerCover && r.amount > 30;
      });
      if (expandableResources.length > 0 && myShare < 0.4 && gameTimeMin > 2.5) {
        reward -= 8.0;
        reasons.push(`MISSED_EXPANSION: ${expandableResources.length} нейтральных ресурсов (${neutralValue.toFixed(0)} ценности) не под контролем!`);
      }
    }
    const busyWarehouses = myWarehouses.filter(w => (w.workers || 0) >= (w.maxDeliveryWorkers || 5) * 0.6).length;
    if (busyWarehouses > 0 && myWarehouses.length > 0) {
      const efficiencyRatio = busyWarehouses / myWarehouses.length;
      if (efficiencyRatio > 0.7) {
        reward += 5.0;
        reasons.push(`WAREHOUSE_EFFICIENCY: ${(efficiencyRatio * 100).toFixed(0)}% складов загружены`);
      }
    }
    if (!this._lastOutpostCount) this._lastOutpostCount = 0;
    const currentOutposts = gameState.buildings.filter(b =>
      b.owner === "ai" && b.type === "beacon" && b.active &&
      gameState.buildings.some(o =>
        o.owner === "ai" && o !== b &&
        ["warehouse","turret","turret2","turret3"].includes(o.type) &&
        Math.hypot(o.x - b.x, o.y - b.y) < 300
      )
    ).length;
    if (currentOutposts < this._lastOutpostCount && gameTimeMin > 3.0) {
      const lostOutposts = this._lastOutpostCount - currentOutposts;
      const lossPenalty = -20.0 * lostOutposts;
      reward += lossPenalty;
      reasons.push(`OUTPOST_LOST: потеряли ${lostOutposts} форпостов! (штраф ${lossPenalty.toFixed(1)})`);
    }
    this._lastOutpostCount = currentOutposts;
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
      const stabilityBonus = 5.0 * stableOutposts;
      reward += stabilityBonus;
      reasons.push(`STABLE_OUTPOSTS: ${stableOutposts} форпостов удерживаются 2+ мин (+${stabilityBonus.toFixed(1)})`);
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
        if (reward > 0) console.log(`[GnnAI] 💎 Контроль ресурсов: +${reward.toFixed(1)} (${reasons.join(', ')})`);
        else console.warn(`[GnnAI] ⚠️ Контроль ресурсов: ${reward.toFixed(1)} (${reasons.join(', ')})`);
      }
    }
  },

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
    myUnits.forEach(u => { myPower += u.health + (this.getUnitDps(u.type) * 10); });
    let enemyPower = 0;
    enemyUnits.forEach(u => { enemyPower += u.health + (this.getUnitDps(u.type) * 10); });
    const turretCount = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0).length;
    const myDefensePower = turretCount * 150;
    const totalMyStrength = myPower + myDefensePower;
    if (enemyPower > 0) {
      if (totalMyStrength < enemyPower * 0.5) { penalty -= 10.0; reasons.push("CRITICAL_WEAK_DEFENSE: Враг в 2 раза сильнее!"); }
      else if (totalMyStrength > enemyPower * 1.5) { penalty += 5.0; reasons.push("STRONG_DEFENSE: Превосходство в силе!"); }
    }
    if (m.enemyNear > 0 && m.baseHp > 0.95 && turretCount > 0) { penalty += 3.0; reasons.push("EFFECTIVE_DEFENSE: База цела под огнем!"); }
    if (penalty !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: this._AIDX.idle, reward: penalty });
        if (penalty < 0) console.warn(`[GnnAI] ⚠️ Дисбаланс сил: ${penalty} (${reasons.join(', ')})`);
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
        this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: this._AIDX.idle, reward: penalty });
        console.warn(`[GnnAI] ⚠️ Отставание от противника: ${penalty} (${reasons.join(', ')})`);
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
    if (combatUnits.length >= 3 && idleRatio > 0.7 && gameTimeMin > 2.5) {
      const idlePenalty = -20.0 * idleRatio;
      reward += idlePenalty;
      reasons.push(`ARMY_IDLE_CRITICAL: ${idleUnits}/${combatUnits.length} бойцов без команд (${idlePenalty.toFixed(1)})`);
    } else if (combatUnits.length >= 2 && idleRatio > 0.5 && gameTimeMin > 2.0) {
      const idlePenalty = -10.0 * idleRatio;
      reward += idlePenalty;
      reasons.push(`ARMY_IDLE: ${idleUnits}/${combatUnits.length} бойцов без команд (${idlePenalty.toFixed(1)})`);
    }
    if (idleUnits >= 3 && m.enemyNear === 0 && gameTimeMin > 3.0) {
      let baseCampingCount = 0;
      combatUnits.forEach(u => {
        const distToBase = Math.hypot(u.x - aiBase.x, u.y - aiBase.y);
        if (distToBase < 300) baseCampingCount++;
      });
      if (baseCampingCount >= 3) {
        const campingPenalty = -15.0;
        reward += campingPenalty;
        reasons.push(`ARMY_CAMPING: ${baseCampingCount} бойцов сидят у базы без причины (${campingPenalty})`);
      }
    }
    if (attackingUnits >= 2) {
      const attackBonus = Math.min(15.0, attackingUnits * 3.0);
      reward += attackBonus;
      reasons.push(`ARMY_ATTACKING: ${attackingUnits} бойцов в атаке (+${attackBonus.toFixed(1)})`);
    }
    if (defendingUnits >= 2 && m.enemyNear > 0) {
      const defenseBonus = Math.min(10.0, defendingUnits * 2.0);
      reward += defenseBonus;
      reasons.push(`ARMY_DEFENDING: ${defendingUnits} бойцов защищают (+${defenseBonus.toFixed(1)})`);
    }
    const activeMissions = this.missionCache.filter(m =>
      !m.resolved && (m.intent.type === "attack" || m.intent.type === "defend")
    ).length;
    if (combatUnits.length >= 3 && activeMissions === 0 && gameTimeMin > 3.0) {
      const noMissionPenalty = -12.0;
      reward += noMissionPenalty;
      reasons.push(`ARMY_NO_MISSION: ${combatUnits.length} бойцов, но НЕТ активных миссий (${noMissionPenalty})`);
    }
    if (attackingUnits > 0 && defendingUnits > 0) {
      reward += 8.0;
      reasons.push(`ARMY_DIVERSITY: армия разделена на атаку (${attackingUnits}) и защиту (${defendingUnits})`);
    }
    if (!this._lastArmyPositions) this._lastArmyPositions = new Map();
    let stuckUnits = 0;
    combatUnits.forEach(u => {
      const lastPos = this._lastArmyPositions.get(u.id);
      if (lastPos) {
        const moved = Math.hypot(u.x - lastPos.x, u.y - lastPos.y);
        if (moved < 5) stuckUnits++;
      }
      this._lastArmyPositions.set(u.id, { x: u.x, y: u.y });
    });
    if (stuckUnits >= 3 && stuckUnits > combatUnits.length * 0.5 && gameTimeMin > 2.5) {
      const stuckPenalty = -8.0;
      reward += stuckPenalty;
      reasons.push(`ARMY_STUCK: ${stuckUnits}/${combatUnits.length} бойцов стоят на месте (${stuckPenalty})`);
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
        if (reward > 0) console.log(`[GnnAI] ⚔️ Активность армии: +${reward.toFixed(1)} (${reasons.join(', ')})`);
        else console.warn(`[GnnAI] ⚠️ Активность армии: ${reward.toFixed(1)} (${reasons.join(', ')})`);
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
    if (deltaDeaths > 0 || deltaKills > 0) {
      const kdRatio = deltaKills / Math.max(1, deltaDeaths);
      if (kdRatio >= 2.0 && deltaKills >= 2) {
        const kdBonus = Math.min(25.0, kdRatio * 8.0 + deltaKills * 3.0);
        reward += kdBonus;
        reasons.push(`EXCELLENT_KD: убито ${deltaKills}, потеряно ${deltaDeaths} (K/D=${kdRatio.toFixed(2)}, +${kdBonus.toFixed(1)})`);
      } else if (kdRatio >= 1.0 && deltaKills >= 1) {
        reward += 8.0;
        reasons.push(`GOOD_KD: убито ${deltaKills}, потеряно ${deltaDeaths} (K/D=${kdRatio.toFixed(2)})`);
      } else if (kdRatio < 0.5 && deltaDeaths >= 2) {
        const kdPenalty = -12.0 * (1 - kdRatio) * Math.min(3, deltaDeaths);
        reward += kdPenalty;
        reasons.push(`BAD_KD: убито ${deltaKills}, потеряно ${deltaDeaths} (K/D=${kdRatio.toFixed(2)}, ${kdPenalty.toFixed(1)})`);
      }
    }
    if (deltaDeaths >= 2 && deltaDamageDealt < 20 && gameTimeMin > 2.0) {
      const wastePenalty = -15.0 * deltaDeaths;
      reward += wastePenalty;
      reasons.push(`WASTED_UNITS: ${deltaDeaths} юнитов погибло, урон только ${deltaDamageDealt.toFixed(0)} (${wastePenalty.toFixed(1)})`);
    }
    if (deltaDamageDealt > 50 && deltaDamageTaken > 0) {
      const damageEfficiency = deltaDamageDealt / deltaDamageTaken;
      if (damageEfficiency > 2.0) {
        const effBonus = Math.min(15.0, damageEfficiency * 5.0);
        reward += effBonus;
        reasons.push(`DAMAGE_EFFICIENT: нанесли ${deltaDamageDealt.toFixed(0)} урона, получили ${deltaDamageTaken.toFixed(0)} (эффективность ${damageEfficiency.toFixed(1)}x, +${effBonus.toFixed(1)})`);
      }
    }
    if (deltaDamageTaken > 100 && deltaDamageDealt < deltaDamageTaken * 0.5) {
      const ineffPenalty = -10.0;
      reward += ineffPenalty;
      reasons.push(`DAMAGE_INEFFICIENT: получили ${deltaDamageTaken.toFixed(0)} урона, нанесли только ${deltaDamageDealt.toFixed(0)} (${ineffPenalty})`);
    }
    if (aliveMyUnits.length >= 3 && gameTimeMin > 3.0) {
      const healthyUnits = aliveMyUnits.filter(u => u.health > u.maxHealth * 0.7).length;
      const healthRatio = healthyUnits / aliveMyUnits.length;
      if (healthRatio >= 0.8) {
        const healthBonus = 5.0 + aliveMyUnits.length * 1.0;
        reward += healthBonus;
        reasons.push(`ARMY_HEALTHY: ${healthyUnits}/${aliveMyUnits.length} юнитов здоровы (+${healthBonus.toFixed(1)})`);
      }
    }
    if (aliveMyUnits.length >= 2 && gameTimeMin > 2.5) {
      const woundedUnits = aliveMyUnits.filter(u => u.health < u.maxHealth * 0.4).length;
      const woundedRatio = woundedUnits / aliveMyUnits.length;
      if (woundedRatio > 0.6) {
        const woundedPenalty = -12.0;
        reward += woundedPenalty;
        reasons.push(`ARMY_WOUNDED: ${woundedUnits}/${aliveMyUnits.length} юнитов при смерти (${woundedPenalty})`);
      }
    }
    if (aliveMyUnits.length === 0 && aliveEnemyUnits.length > 0 && gameTimeMin > 2.0) {
      const ghostPenalty = -20.0;
      reward += ghostPenalty;
      reasons.push(`GHOST_ARMY: вся армия погибла, но враг ещё жив! (${ghostPenalty})`);
    }
    if (aliveMyUnits.length > aliveEnemyUnits.length * 1.5 && aliveMyUnits.length >= 3) {
      const superiorityBonus = 6.0;
      reward += superiorityBonus;
      reasons.push(`ARMY_SUPERIORITY: наша армия ${aliveMyUnits.length} vs враг ${aliveEnemyUnits.length} (+${superiorityBonus})`);
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
        if (reward > 0) console.log(`[GnnAI] ⚔️ Эффективность боя: +${reward.toFixed(1)} (${reasons.join(', ')})`);
        else console.warn(`[GnnAI] ⚠️ Эффективность боя: ${reward.toFixed(1)} (${reasons.join(', ')})`);
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
    let goodTargets = 0, badTargets = 0, isolatedTargets = 0, turretProtectedTargets = 0;
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
      const isProtected = turretsNearTarget >= 2;
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
      else if (isProtected && losses > 0) { badTargets++; turretProtectedTargets++; }
      else if (damageDealt > 100 && losses === 0) { goodTargets++; }
      else if (losses > 2 && damageDealt < 50) { badTargets++; }
    });
    if (goodTargets > 0) {
      const goodBonus = Math.min(20.0, goodTargets * 8.0);
      reward += goodBonus;
      reasons.push(`GOOD_TARGETS: ${goodTargets} хорошо выбранных целей (+${goodBonus.toFixed(1)})`);
    }
    if (isolatedTargets > 0) {
      const isolatedBonus = Math.min(15.0, isolatedTargets * 6.0);
      reward += isolatedBonus;
      reasons.push(`ISOLATED_TARGETS: ${isolatedTargets} изолированных целей (+${isolatedBonus.toFixed(1)})`);
    }
    if (badTargets > 0) {
      const badPenalty = -12.0 * badTargets;
      reward += badPenalty;
      reasons.push(`BAD_TARGETS: ${badTargets} плохо выбранных целей (${badPenalty.toFixed(1)})`);
    }
    if (turretProtectedTargets > 0 && totalLosses > 0) {
      const turretPenalty = -15.0 * turretProtectedTargets;
      reward += turretPenalty;
      reasons.push(`TURRET_TRAP: ${turretProtectedTargets} атак под турелями с потерями (${turretPenalty.toFixed(1)})`);
    }
    if (totalDamageDealt > 100 && totalDamageTaken > 0) {
      const efficiency = totalDamageDealt / totalDamageTaken;
      if (efficiency > 2.5) {
        const effBonus = Math.min(12.0, efficiency * 3.0);
        reward += effBonus;
        reasons.push(`TARGET_EFFICIENCY: урон/потери = ${efficiency.toFixed(1)}x (+${effBonus.toFixed(1)})`);
      }
    }
    if (totalLosses > 3 && totalDamageDealt < 100) {
      const ineffPenalty = -10.0;
      reward += ineffPenalty;
      reasons.push(`TARGET_INEFFICIENT: ${totalLosses} потерь, но урон только ${totalDamageDealt.toFixed(0)} (${ineffPenalty})`);
    }
    const uniqueTargets = new Set(recentAttacks.map(m => m.snapshot.targetId)).size;
    if (uniqueTargets >= 3 && recentAttacks.length >= 3) {
      reward += 8.0;
      reasons.push(`TARGET_DIVERSITY: атаковано ${uniqueTargets} разных целей (+8)`);
    }
    const targetCounts = {};
    recentAttacks.forEach(m => {
      const id = m.snapshot.targetId;
      targetCounts[id] = (targetCounts[id] || 0) + 1;
    });
    const maxSameTarget = Math.max(...Object.values(targetCounts));
    if (maxSameTarget >= 3 && recentAttacks.length >= 4) {
      const spamPenalty = -8.0;
      reward += spamPenalty;
      reasons.push(`TARGET_SPAM: одна цель атакована ${maxSameTarget} раз (${spamPenalty})`);
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
        if (reward > 0) console.log(`[GnnAI] 🎯 Выбор целей: +${reward.toFixed(1)} (${reasons.join(', ')})`);
        else console.warn(`[GnnAI] ⚠️ Выбор целей: ${reward.toFixed(1)} (${reasons.join(', ')})`);
      }
    }
  },

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
      reward += Math.min(20.0, importantEnemySightings * 8.0);
      reasons.push(`INTEL_FOUND: обнаружено ${importantEnemySightings} важных целей`);
    } else if (newEnemySightings > 0) {
      reward += Math.min(10.0, newEnemySightings * 3.0);
      reasons.push(`INTEL_FOUND: обнаружено ${newEnemySightings} врагов`);
    } else if (combatUnits.length > 0) {
      let maxDist = 0;
      combatUnits.forEach(u => {
        const d = Math.hypot(u.x - aiBase.x, u.y - aiBase.y);
        if (d > maxDist) maxDist = d;
      });
      if (maxDist > 500) {
        const orbitPenalty = -8.0 * (maxDist / 500);
        reward += orbitPenalty;
        reasons.push(`ORBITAL_RECON_PENALTY: юниты на ${maxDist.toFixed(0)}px, но ничего не видят (${orbitPenalty.toFixed(1)})`);
      } else if (maxDist > 300) {
        reward -= 3.0;
        reasons.push(`WEAK_RECON: юниты на ${maxDist.toFixed(0)}px, ничего не видят`);
      } else {
        if (m.enemyNear > 0) {
          reward += 2.0;
          reasons.push(`LOCAL_DEFENSE_RECON: юниты рядом с базой, враги обнаружены`);
        }
      }
    }
    if (combatUnits.length > 0) {
      let totalDist = 0;
      combatUnits.forEach(u => {
        totalDist += Math.hypot(u.x - aiBase.x, u.y - aiBase.y);
      });
      const avgDist = totalDist / combatUnits.length;
      if (gameTimeMin > 2.0 && avgDist < 200 && combatUnits.length >= 3 && m.enemyNear === 0) {
        const campPenalty = -10.0;
        reward += campPenalty;
        reasons.push(`BASE_CAMPING: ${combatUnits.length} юнитов сидят у базы без причины`);
      }
    }
    if (combatUnits.length >= 3) {
      const directions = new Set();
      combatUnits.forEach(u => {
        const angle = Math.atan2(u.y - aiBase.y, u.x - aiBase.x);
        const sector = Math.floor((angle + Math.PI) / (Math.PI / 2));
        directions.add(sector);
      });
      if (directions.size === 1) {
        reward -= 5.0;
        reasons.push(`SINGLE_DIRECTION: все ${combatUnits.length} юнитов в одном направлении`);
      } else if (directions.size >= 3) {
        if (newEnemySightings > 0 || importantEnemySightings > 0) {
          reward += 5.0;
          reasons.push(`MULTI_DIRECTION_INTEL: разведка в ${directions.size} направлениях с обнаружением врагов`);
        }
      }
    }
    if (gameTimeMin > 3.0 && combatUnits.length === 0) {
      reward -= 8.0;
      reasons.push(`NO_RECON_FOR_LONG_TIME: ${gameTimeMin.toFixed(1)} мин без разведки`);
    }
    if (gameTimeMin > 2.0 && m.aiArmy === 0) {
      reward -= 5.0;
      reasons.push("NO_ARMY_FOR_RECON: нет боевых юнитов");
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
        if (reward > 0) console.log(`[GnnAI] 🛰️ Разведка: +${reward.toFixed(1)} (${reasons.join(', ')})`);
        else console.warn(`[GnnAI] ⚠️ Разведка: ${reward.toFixed(1)} (${reasons.join(', ')})`);
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
        reward -= 10.0;
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
          //console.warn(`[GnnAI] 🏗️ Экспансия: ${reward.toFixed(1)} (${reasons.join(', ')})`);
        }
      }
      return;
    }
    const outposts = [];
    const beacons = aiBuildings.filter(b => b.type === "beacon");
    beacons.forEach(beacon => {
      const nearby = aiBuildings.filter(b =>
        Math.hypot(b.x - beacon.x, b.y - beacon.y) < 300
      );
      const hasTurret = nearby.some(b => b.type.startsWith("turret"));
      const hasWarehouse = nearby.some(b => b.type === "warehouse");
      const hasWorkshop = nearby.some(b => b.type === "repairWorkshop");
      const hasBarracks = nearby.some(b => b.type.startsWith("barracks"));
      const score = (hasTurret ? 1 : 0) + (hasWarehouse ? 1 : 0) +
                    (hasWorkshop ? 1 : 0) + (hasBarracks ? 1 : 0);
      if (score >= 3) {
        outposts.push({ beacon, score, buildings: nearby });
      }
    });
    if (outposts.length > 0) {
      let outpostReward = 0;
      for (let i = 0; i < outposts.length; i++) {
        if (i === 0) outpostReward += 25.0;
        else if (i === 1) outpostReward += 20.0;
        else if (i === 2) outpostReward += 15.0;
        else outpostReward += 10.0;
      }
      reward += outpostReward;
      reasons.push(`OUTPOSTS_BUILT: ${outposts.length} полноценных форпостов (+${outpostReward.toFixed(1)}, убывающая ценность)`);
      if (outposts.length === 1 && gameTimeMin > 5.0) {
        reward -= 10.0;
        reasons.push("STAGNANT_EXPANSION: только 1 форпост после 5 минут!");
      } else if (outposts.length === 0 && gameTimeMin > 3.0 && m.resTotal > 0.3) {
        reward -= 15.0;
        reasons.push("NO_OUTPOSTS: нет форпостов после 3 минут при ресурсах > 600!");
      }
      outposts.forEach(op => {
        const dist = Math.hypot(op.beacon.x - aiBase.x, op.beacon.y - aiBase.y);
        const hasDefense = op.buildings.some(b => b.type.startsWith("turret"));
        const hasEconomy = op.buildings.some(b => b.type === "warehouse");
        if (dist > 500) {
          if (hasDefense && hasEconomy) {
            reward += 20.0;
            reasons.push(`DEEP_SECURED_OUTPOST: форпост на ${dist.toFixed(0)}px с защитой и экономикой`);
          } else if (hasDefense) {
            reward += 8.0;
            reasons.push(`DEEP_DEFENDED_OUTPOST: форпост на ${dist.toFixed(0)}px с защитой`);
          } else {
            reward -= 12.0;
            reasons.push(`VULNERABLE_DEEP_OUTPOST: форпост на ${dist.toFixed(0)}px БЕЗ защиты!`);
          }
        } else if (dist > 350) {
          if (hasDefense && hasEconomy) {
            reward += 12.0;
            reasons.push(`MEDIUM_SECURED_OUTPOST: форпост на ${dist.toFixed(0)}px с защитой и экономикой`);
          } else if (hasDefense) {
            reward += 5.0;
            reasons.push(`MEDIUM_DEFENDED_OUTPOST: форпост на ${dist.toFixed(0)}px с защитой`);
          } else {
            reward -= 8.0;
            reasons.push(`VULNERABLE_MEDIUM_OUTPOST: форпост на ${dist.toFixed(0)}px БЕЗ защиты!`);
          }
        }
      });
    }
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
        const clusterPenalty = -15.0;
        reward += clusterPenalty;
        reasons.push(`BUILDING_CLUSTER: здания слишком близко (среднее ${avgDist.toFixed(0)}px)`);
      } else if (avgDist < 250) {
        const minorPenalty = -5.0;
        reward += minorPenalty;
        reasons.push(`SLIGHT_CLUSTER: здания близко (среднее ${avgDist.toFixed(0)}px)`);
      } else if (avgDist > 400) {
        reward += 10.0;
        reasons.push(`GOOD_SPREAD: здания хорошо распределены (среднее ${avgDist.toFixed(0)}px)`);
      }
    }
    const buildingTypes = new Set(aiBuildings.map(b => b.type));
    const typeCounts = {};
    aiBuildings.forEach(b => {
      typeCounts[b.type] = (typeCounts[b.type] || 0) + 1;
    });
    const maxSameType = Math.max(...Object.values(typeCounts));
    if (maxSameType >= 4 && aiBuildings.length >= 6) {
      const spamPenalty = -10.0;
      reward += spamPenalty;
      reasons.push(`BUILDING_SPAM: ${maxSameType} зданий одного типа — кучкование!`);
    }
    if (aiBuildings.length >= 5) {
      const clusters = [];
      const visited = new Set();
      for (let i = 0; i < aiBuildings.length; i++) {
        if (visited.has(i)) continue;
        const cluster = [aiBuildings[i]];
        visited.add(i);
        for (let j = i + 1; j < aiBuildings.length; j++) {
          if (visited.has(j)) continue;
          const dist = Math.hypot(aiBuildings[i].x - aiBuildings[j].x, aiBuildings[i].y - aiBuildings[j].y);
          if (dist < 300) {
            cluster.push(aiBuildings[j]);
            visited.add(j);
          }
        }
        const cx = cluster.reduce((s, b) => s + b.x, 0) / cluster.length;
        const cy = cluster.reduce((s, b) => s + b.y, 0) / cluster.length;
        clusters.push({ x: cx, y: cy, size: cluster.length });
      }
      if (clusters.length >= 2) {
        let totalClusterDist = 0;
        let pairCount = 0;
        for (let i = 0; i < clusters.length; i++) {
          for (let j = i + 1; j < clusters.length; j++) {
            totalClusterDist += Math.hypot(clusters[i].x - clusters[j].x, clusters[i].y - clusters[j].y);
            pairCount++;
          }
        }
        const avgClusterDist = totalClusterDist / pairCount;
        if (avgClusterDist > 400) {
          const spreadBonus = Math.min(15.0, (avgClusterDist - 400) / 50);
          reward += spreadBonus;
          reasons.push(`GOOD_EXPANSION: ${clusters.length} кластеров, среднее расстояние ${avgClusterDist.toFixed(0)}px (+${spreadBonus.toFixed(1)})`);
        } else if (avgClusterDist < 200 && clusters.length >= 2) {
          const clusterPenalty = -15.0;
          reward += clusterPenalty;
          reasons.push(`CLUSTERED_EXPANSION: все кластеры слишком близко (${avgClusterDist.toFixed(0)}px)`);
        }
      }
    }
    if (buildingTypes.size >= 4) {
      const farBuildings = aiBuildings.filter(b => {
        const dist = Math.hypot(b.x - aiBase.x, b.y - aiBase.y);
        return dist > 400;
      });
      if (farBuildings.length >= 2) {
        reward += 3.0;
        reasons.push(`DIVERSITY_WITH_EXPANSION: ${buildingTypes.size} типов зданий, ${farBuildings.length} далеко от базы`);
      }
    }
    if (gameTimeMin > 3.0 && beacons.length === 0 && m.resTotal > 0.3) {
      reward -= 12.0;
      reasons.push("NO_BEACONS: есть ресурсы, но нет маяков для экспансии");
    }
    if (gameTimeMin < 4.0 && outposts.length > 0) {
      if (outposts.length >= 2) {
        reward += 30.0;
        reasons.push(`EXCELLENT_EARLY_EXPANSION: ${outposts.length} форпостов до 4 минут!`);
      } else if (outposts.length === 1) {
        reward += 10.0;
        reasons.push("BASIC_EARLY_EXPANSION: 1 форпост до 4 минут");
      }
    }
    if (gameTimeMin >= 4.0 && gameTimeMin < 7.0 && outposts.length === 0 && m.resTotal > 0.2) {
      reward -= 20.0;
      reasons.push("MID_GAME_NO_EXPANSION: 4-7 минут, нет форпостов при ресурсах > 400!");
    }
    if (gameTimeMin >= 7.0 && outposts.length < 2 && m.resTotal > 0.3) {
      reward -= 25.0;
      reasons.push("LATE_GAME_NO_EXPANSION: 7+ минут, <2 форпостов при ресурсах > 600!");
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
          const isEconomic = ["warehouse","repairWorkshop"].includes(mem.type);
          const isMilitary = ["turret","turret2","turret3","barracks","barracks2","barracks3"].includes(mem.type);
          if (isImportant) {
            valuableDiscoveries.push({
              mem,
              value: isMilitary ? 15.0 : (isEconomic ? 12.0 : 20.0)
            });
          }
        }
      }
    }
    if (recentDiscoveries.length > 0) {
      const cappedDiscoveries = Math.min(3, recentDiscoveries.length);
      const discoveryReward = cappedDiscoveries * 3.0;
      reward += discoveryReward;
      reasons.push(`RECON_DISCOVERY: обнаружено ${recentDiscoveries.length} объектов (учтено ${cappedDiscoveries}, +${discoveryReward.toFixed(1)})`);
      if (valuableDiscoveries.length > 0) {
        const cappedValuable = valuableDiscoveries.slice(0, 2);
        const importantReward = cappedValuable.reduce((sum, d) => sum + d.value, 0);
        reward += importantReward;
        reasons.push(`IMPORTANT_RECON: ${cappedValuable.length} важных целей (+${importantReward.toFixed(1)})`);
      }
    }
    const enemyDiscoveries = recentDiscoveries.filter(d => d.owner === "player");
    if (recentDiscoveries.length > 0 && enemyDiscoveries.length === 0 && gameTimeMin > 2.0) {
      reward -= 2.0;
      reasons.push("USELESS_RECON: открыли только ресурсы, но не врагов");
    }
    const staleDiscoveries = Array.from(this.reconMemory.values()).filter(m =>
      m.owner === "player" && m._rewarded && (now - m._firstSeenAt) > 30000
    );
    if (staleDiscoveries.length > 5 && recentDiscoveries.length === 0 && gameTimeMin > 3.0) {
      reward -= 5.0;
      reasons.push("STALE_RECON: нет новых открытий, хотя знаем о врагах");
    }
    const enemyNodesInMemory = Array.from(this.reconMemory.values()).filter(m => m.owner === "player");
    if (enemyNodesInMemory.length === 0 && gameTimeMin > 1.0) {
      reward -= 5.0;
      reasons.push("BLIND: нет информации о враге!");
    }
    if (gameTimeMin > 5.0 && enemyNodesInMemory.length < 3) {
      reward -= 8.0;
      reasons.push(`LATE_GAME_BLINDNESS: 5+ минут, но знаем только о ${enemyNodesInMemory.length} вражеских объектах!`);
    }
    const combatUnits = gameState.units.filter(u =>
      u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
    );
    let activeReconCount = 0;
    combatUnits.forEach(u => {
      const distFromBase = Math.hypot(u.x - aiBase.x, u.y - aiBase.y);
      if (distFromBase > 400) {
        const enemiesNearUnit = gameState.units.filter(e =>
          e.owner === "player" && e.health > 0 &&
          Math.hypot(e.x - u.x, e.y - u.y) < 300
        ).length;
        if (enemiesNearUnit > 0) activeReconCount++;
      }
    });
    if (activeReconCount > 0) {
      const activeReconBonus = Math.min(10.0, activeReconCount * 3.0);
      reward += activeReconBonus;
      reasons.push(`ACTIVE_RECON: ${activeReconCount} юнитов далеко от базы видят врагов (+${activeReconBonus.toFixed(1)})`);
    }
    if (reward !== 0) {
      const state = this.buildGraphState();
      if (state) {
        this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: this._AIDX.idle, reward });
        if (reward > 0) console.log(`[GnnAI] 🔭 Разведка: +${reward.toFixed(1)} (${reasons.join(', ')})`);
        else console.warn(`[GnnAI] ⚠️ Разведка: ${reward.toFixed(1)} (${reasons.join(', ')})`);
      }
    }
  },

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
    const hasBarracks2 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks2" && b.active);
    const hasBase3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "base3" && b.active);
    const hasBarracks3 = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks3" && b.active);
    const armySize = m.aiArmy;

    const currentTier = this.curriculumTier;
    if (currentTier === 0 && warehouses >= 2 && workers >= 4) {
      this.curriculumTier = 1;
      //console.log(`[Curriculum] 🎓 Milestone: Tier 1 (Экономика стабильна)`);
    } else if (currentTier === 1 && hasBarracks && armySize >= 2) {
      this.curriculumTier = 2;
      //console.log(`[Curriculum] 🎓 Milestone: Tier 2 (Есть казарма и армия)`);
    } else if (currentTier === 2 && hasBarracks2 && gameState.buildings.some(b => b.owner === "ai" && b.type === "turret2" && b.active)) {
      this.curriculumTier = 3;
      //console.log(`[Curriculum] 🎓 Milestone: Tier 3 (Технологии Тир-2 освоены)`);
    }

    const currentTechLevel = m.techLevel;
    let phaseReward = 0;
    let reasons = [];
    if (!this._lastRewardedTechLevel) this._lastRewardedTechLevel = 1;
    if (currentTechLevel > this._lastRewardedTechLevel) {
      if (currentTechLevel === 2) {
        phaseReward += 100.0;
        reasons.push("🏆 TIER2_TRANSITION: Переход на Тир-2! Бонус +100");
        if (gameTimeMin < 5.0) {
          phaseReward += 50.0;
          reasons.push("⚡ FAST_TIER2: Переход на Тир-2 до 5 минут! +50");
        } else if (gameTimeMin < 7.0) {
          phaseReward += 25.0;
          reasons.push("👍 GOOD_TIER2: Переход на Тир-2 до 7 минут! +25");
        }
      } else if (currentTechLevel === 3) {
        phaseReward += 200.0;
        reasons.push("🏆🏆 TIER3_TRANSITION: Переход на Тир-3! Бонус +200");
        if (gameTimeMin < 10.0) {
          phaseReward += 100.0;
          reasons.push("⚡⚡ FAST_TIER3: Переход на Тир-3 до 10 минут! +100");
        } else if (gameTimeMin < 13.0) {
          phaseReward += 50.0;
          reasons.push("👍 GOOD_TIER3: Переход на Тир-3 до 13 минут! +50");
        }
      }
      this._lastRewardedTechLevel = currentTechLevel;
    }
    const timeSinceLastTier = this._lastTierTransitionTime ? (now - this._lastTierTransitionTime) / 60000 : gameTimeMin;
    if (currentTechLevel === 1 && gameTimeMin > 5.0) {
      const stagnationPenalty = -15.0 * (gameTimeMin - 5.0);
      phaseReward += Math.max(-100.0, stagnationPenalty);
      reasons.push(`🐌 TIER1_STAGNATION: ${gameTimeMin.toFixed(1)} мин на Тир-1 (штраф ${stagnationPenalty.toFixed(1)})`);
    } else if (currentTechLevel === 2 && gameTimeMin > 12.0) {
      const stagnationPenalty = -10.0 * (gameTimeMin - 12.0);
      phaseReward += Math.max(-80.0, stagnationPenalty);
      reasons.push(`🐌 TIER2_STAGNATION: ${gameTimeMin.toFixed(1)} мин на Тир-2 (штраф ${stagnationPenalty.toFixed(1)})`);
    }
    if (currentTechLevel > (this._lastKnownTechLevel || 1)) {
      this._lastTierTransitionTime = now;
      this._lastKnownTechLevel = currentTechLevel;
    }

    const barracks = gameState.buildings.some(b => b.owner === "ai" && b.type === "barracks");
    if (gameTimeMin < 2.0) {
      const wCount = workers;
      const barr = hasBarracks;
      if (wCount >= 4) { phaseReward += 20.0; reasons.push("PHASE1_EXCELLENT_ECONOMY_4+_WORKERS"); }
      else if (wCount >= 2) { phaseReward += 10.0; reasons.push("PHASE1_GOOD_ECONOMY_2+_WORKERS"); }
      else if (wCount >= 1) { phaseReward += 3.0; reasons.push("PHASE1_BASIC_ECONOMY"); }
      if (gameTimeMin > 1.0 && wCount < 2) { phaseReward -= 30.0; reasons.push("PHASE1_CRITICAL_ECONOMIC_STAGNATION"); }
      if (gameTimeMin > 1.5 && m.aiWarehouses < 2) { phaseReward -= 20.0; reasons.push("PHASE1_LACK_OF_INFRASTRUCTURE"); }
      if (barr && wCount < 3) { phaseReward -= 30.0; reasons.push("PHASE1_PREMATURE_MILITARY_SUICIDE"); }
    } else if (gameTimeMin < 4.0) {
      const wCount = workers;
      const barr = hasBarracks;
      if (barr && wCount >= 4) { phaseReward += 20.0; reasons.push("PHASE2_PERFECT_MACRO_BALANCE"); }
      if (m.resTotal > 100 && m.aiWarehouses < 2) { phaseReward -= 25.0; reasons.push("PHASE2_HOARDING_WITHOUT_EXPANSION"); }
      if (armySize > 0 && wCount < 3) { phaseReward -= 15.0; reasons.push("PHASE2_ATTACKING_WITH_WEAK_ECONOMY"); }
      if (armySize === 0 && gameTimeMin > 3.0) { phaseReward -= 15.0; reasons.push("PHASE2_ZERO_ARMY_PENALTY"); }
    } else if (gameTimeMin < 6.0) {
      if (hasBase2) {
        phaseReward += 30.0;
        reasons.push("PHASE3_TIER2_ACHIEVEMENT_BONUS");
      }
      if (!hasBase2) {
        const minutesLate = gameTimeMin - 3.0;
        phaseReward -= (8.0 * minutesLate);
        reasons.push(`PHASE3_TIER1_STAGNATION_PENALTY (-${(8.0 * minutesLate).toFixed(1)})`);
      }
    } else {
      const eliteCount = gameState.units.filter(u => u.owner === "ai" && u.type === "elite").length;
      const assaultCount = gameState.units.filter(u => u.owner === "ai" && u.type === "assault").length;
      if (eliteCount > 0) {
        phaseReward += 20.0;
        reasons.push("PHASE4_ELITE_UNITS_BONUS");
      }
      if (assaultCount > 0) {
        phaseReward += 10.0;
        reasons.push("PHASE4_ASSAULT_UNITS_BONUS");
      }
      if (armySize > 10) {
        const fighterCount = gameState.units.filter(u => u.owner === "ai" && u.type === "fighter").length;
        if (fighterCount / armySize > 0.9) { phaseReward -= 8.0; reasons.push("PHASE4_INEFFICIENT_ARMY_COMPOSITION_PENALTY"); }
      }
      if (gameTimeMin > 15.0 && currentTechLevel < 3) {
        phaseReward -= 20.0;
        reasons.push("PHASE4_LATE_GAME_NO_TIER3: 15+ мин, но нет Тир-3!");
      }
    }
    if (phaseReward !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: this._AIDX.idle, reward: phaseReward });
        if (reasons.some(r => r.includes("TIER2_TRANSITION") || r.includes("TIER3_TRANSITION"))) {
          //console.log(`[GnnAI] 🎯 ФАЗА: +${phaseReward.toFixed(1)} (${reasons.join(', ')})`);
        } else if (phaseReward < -10) {
          //console.warn(`[GnnAI] ⚠️ ФАЗА: ${phaseReward.toFixed(1)} (${reasons.join(', ')})`);
        }
      }
    }
  },

  // === Технологическая стагнация ===
  checkTechStagnation: function (now) {
    if (!this.lastTechStagnationCheck || now - this.lastTechStagnationCheck < 10000) return;
    this.lastTechStagnationCheck = now;
    const m = this.metrics();
    const gameTimeMin = performance.now() / 60000;
    let penalty = 0;
    let reasons = [];
    const isUnderThreat = this.strategicMemory.threatLevel > 0;
    const hasNoArmy = m.aiArmy === 0;
    if (hasNoArmy && m.resTotal > 0.2 && gameTimeMin > 1.5) {
      penalty -= 30.0;
      reasons.push("CRITICAL_PANIC: Ресурсы есть, а армии НЕТ! Строй казарму!");
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
    if (m.resTotal > 0.1 && m.aiBuildings <= 2 && gameTimeMin > 0.5) {
      penalty -= 50.0;
      reasons.push("LAZY_PENALTY: Есть ресурсы, но ИИ ничего не делает!");
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
    const combatUnits = units.filter(u => ["fighter","assault","elite"].includes(u.type));
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
    const base2Wip = (window.buildQueue || []).some(q => q.type === "base2");
    const barracksWip = (window.buildQueue || []).some(q => q.type === "barracks");
    const base2Cost = typeof BASE2_COST !== 'undefined' ? (BASE2_COST.gold || 0) + (BASE2_COST.silicon || 0) + (BASE2_COST.plasma || 0) : 400;
    if (!hasBase2 && !base2Wip && gameTimeMin > 5.0) {
      const minutesLate = gameTimeMin - 5.0;
      const stagnationPenalty = -8.0 * minutesLate;
      penalty += Math.max(-80.0, stagnationPenalty);
      reasons.push(`TIER2_DELAY_CRITICAL: ${gameTimeMin.toFixed(1)} мин, нет Base2 (штраф ${stagnationPenalty.toFixed(1)})`);
    }
    if (hasBarracks && !hasBase2 && !base2Wip && gameTimeMin > 4.0) {
      const minutesLate = gameTimeMin - 4.0;
      const barracksPenalty = -10.0 * minutesLate;
      penalty += Math.max(-60.0, barracksPenalty);
      reasons.push(`BARRACKS_BUT_NO_BASE2: есть казарма, но нет Base2 после 4 мин (штраф ${barracksPenalty.toFixed(1)})`);
    }
    if (m.resTotal >= (base2Cost / 2000) * 0.8 && !hasBase2 && !base2Wip && gameTimeMin > 3.5) {
      const hoardingPenalty = -15.0;
      penalty += hoardingPenalty;
      reasons.push(`CAN_AFFORD_BASE2: ресурсов хватает на Base2, но ИИ бездействует! (штраф ${hoardingPenalty})`);
    }
    if (m.resTotal > Math.max(0.3, (base2Cost / 2000)) && !hasBase2 && !hasBase3 && !base2Wip && gameTimeMin > 3.0) {
      penalty -= 40.0;
      reasons.push("RICH_FOOL_CRITICAL: Много ресурсов, но застревание на Тир-1! Срочно строй Base2!");
    }
    const orphanBeacons = gameState.buildings.filter(b =>
      b.owner === "ai" && b.type === "beacon" && b.active &&
      !gameState.buildings.some(o => o.owner === "ai" && o !== b &&
        ["warehouse","repairWorkshop","turret","turret2","turret3","barracks"].includes(o.type) &&
        Math.hypot(o.x - b.x, o.y - b.y) < 220)
    );
    if (orphanBeacons.length >= 1 && gameTimeMin > 2) {
      let orphanPenalty = 0;
      for (let i = 0; i < orphanBeacons.length; i++) {
        if (i === 0) orphanPenalty -= 10.0;
        else if (i === 1) orphanPenalty -= 15.0;
        else if (i === 2) orphanPenalty -= 20.0;
        else orphanPenalty -= 25.0;
      }
      penalty += orphanPenalty;
      reasons.push(`ORPHAN_BEACONS_CRITICAL: ${orphanBeacons.length} маяков без фортов! (штраф ${orphanPenalty.toFixed(1)}, прогрессивный)`);
    }
    orphanBeacons.forEach(beacon => {
      const beaconAge = (performance.now() - (beacon.builtAt || performance.now())) / 1000;
      if (beaconAge > 60) {
        const agePenalty = -5.0 * Math.min(3, Math.floor(beaconAge / 60));
        penalty += agePenalty;
        reasons.push(`STALE_ORPHAN_BEACON: маяк на (${beacon.x.toFixed(0)}, ${beacon.y.toFixed(0)}) существует ${beaconAge.toFixed(0)}с без фортов (штраф ${agePenalty.toFixed(1)})`);
      }
    });
    const totalResRaw = (m.res.gold || 0) + (m.res.silicon || 0) + (m.res.plasma || 0);
    const canAffordTurret = typeof TURRET_COST !== 'undefined' &&
      (m.res.gold || 0) >= (TURRET_COST.gold || 0) &&
      (m.res.silicon || 0) >= (TURRET_COST.silicon || 0) &&
      (m.res.plasma || 0) >= (TURRET_COST.plasma || 0);
    const canAffordWarehouse = typeof WAREHOUSE_COST !== 'undefined' &&
      (m.res.gold || 0) >= (WAREHOUSE_COST.gold || 0) &&
      (m.res.silicon || 0) >= (WAREHOUSE_COST.silicon || 0) &&
      (m.res.plasma || 0) >= (WAREHOUSE_COST.plasma || 0);
    if (orphanBeacons.length > 0 && (canAffordTurret || canAffordWarehouse) && gameTimeMin > 2.5) {
      const hoardingPenalty = -12.0 * orphanBeacons.length;
      penalty += hoardingPenalty;
      reasons.push(`ORPHAN_BEACONS_HOARDING: есть ресурсы на достройку, но ИИ бездействует! (штраф ${hoardingPenalty.toFixed(1)})`);
    }
    orphanBeacons.forEach(beacon => {
      const enemiesNearBeacon = gameState.units.filter(u =>
        u.owner === "player" && u.health > 0 &&
        Math.hypot(u.x - beacon.x, u.y - beacon.y) < 400
      ).length;
      if (enemiesNearBeacon > 0) {
        const vulnerablePenalty = -15.0;
        penalty += vulnerablePenalty;
        reasons.push(`VULNERABLE_ORPHAN: маяк под угрозой (${enemiesNearBeacon} врагов рядом)! (штраф ${vulnerablePenalty})`);
      }
    });
    if (hasBarracks && hasBase2 && m.aiArmy > 5 && gameTimeMin > 5) { penalty += 2.0; reasons.push("balanced_development"); }
    if (!hasBarracks && !barracksWip && gameTimeMin > 3) {
      const minutesLate = gameTimeMin - 3;
      penalty -= 3.0 * minutesLate;
      reasons.push(`no_barracks_${minutesLate.toFixed(1)}min_late`);
    }
    if (gameTimeMin > 12 && !hasBase3) { penalty -= 4.0; reasons.push("no_base3_by_12min"); }
    const turretCount = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.active).length;
    if (turretCount > 5 && m.aiArmy < 3 && gameTimeMin > 5) { penalty -= 2.0; reasons.push("turrets_without_army"); }
    if (penalty !== 0) {
      const currentState = this.buildGraphState();
      if (currentState) {
        this.replay.push({ X: currentState.X, A_distance: currentState.A_distance, A_threat: currentState.A_threat, actionIndex: this._AIDX.idle, reward: penalty });
      }
    }
    this.lastResourceTotal = currentRes;
  }

});