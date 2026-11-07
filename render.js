// ============================================================
// render.js — Отрисовка и Canvas
// ============================================================

// Массив с путями к фоновым изображениям
const backgroundImages = [
  '/src/images/background1.png',
  '/src/images/background2.png',
  '/src/images/background3.png',
  '/src/images/background4.png',
  '/src/images/background5.png',
  '/src/images/background6.png',
  '/src/images/background7.png'
];

// Выбор случайного изображения из массива
const randomIndex = Math.floor(Math.random() * backgroundImages.length);
const selectedImage = backgroundImages[randomIndex];

// Создание объекта изображения и установка источника
const backgroundImage = new Image();
backgroundImage.src = selectedImage;
const OWNER_COLORS = {
  player1: { base: "#00FF00", hull: "#00AA00", glow: "rgba(0, 255, 0, 0.5)", accent: "#00FF00" },
  player2: { base: "#FF0000", hull: "#AA0000", glow: "rgba(255, 0, 0, 0.5)", accent: "#FF0000" },
  ai: { base: "#FF0000", hull: "#AA0000", glow: "rgba(255, 0, 0, 0.5)", accent: "#FF0000" },
  player: { base: "#00FF00", hull: "#00AA00", glow: "rgba(0, 255, 0, 0.5)", accent: "#00FF00" }
};

let colorSet = OWNER_COLORS["player"];
function updateColorSet() {
  if (typeof playerId !== "undefined" && OWNER_COLORS[playerId]) colorSet = OWNER_COLORS[playerId];
}

function hexToRgb(hex) {
  hex = hex.replace("#", "");
  return `${parseInt(hex.substring(0, 2), 16)},${parseInt(hex.substring(2, 4), 16)},${parseInt(hex.substring(4, 6), 16)}`;
}

function hexToRgba(hex, alpha = 1) {
  hex = hex.replace("#", "");
  return `rgba(${parseInt(hex.substring(0, 2), 16)},${parseInt(hex.substring(2, 4), 16)},${parseInt(hex.substring(4, 6), 16)},${alpha})`;
}

function createStarLayer(width, height, starCount, minSize, maxSize) {
  const offscreen = document.createElement("canvas");
  offscreen.width = width; offscreen.height = height;
  const ctxOff = offscreen.getContext("2d");
  for (let i = 0; i < starCount; i++) {
    const x = Math.random() * width, y = Math.random() * height;
    const size = minSize + Math.random() * (maxSize - minSize);
    ctxOff.fillStyle = `rgba(255,255,255,${0.5 + Math.random() * 0.5})`;
    ctxOff.beginPath(); ctxOff.arc(x, y, size, 0, Math.PI * 2); ctxOff.fill();
  }
  return offscreen;
}

const starField = {
  layers: [],
  init: function() {
    this.layers = [];
    const starCountLayer1 = isMobile ? 50 : 300;
    const starCountLayer2 = isMobile ? 25 : 200;
    const starCountLayer3 = isMobile ? 10 : 100;
    this.layers.push({ canvas: createStarLayer(canvas.width, canvas.height, starCountLayer1, 0.5, 1.2), speed: 0.1 });
    this.layers.push({ canvas: createStarLayer(canvas.width, canvas.height, starCountLayer2, 1, 2), speed: 0.3 });
    this.layers.push({ canvas: createStarLayer(canvas.width, canvas.height, starCountLayer3, 0.5, 1), speed: 0.5 });
  },
  draw: function() {
    ctx.save();
    this.layers.forEach(layer => {
      const offsetX = - (camera.offsetX * layer.speed) % canvas.width;
      const offsetY = - (camera.offsetY * layer.speed) % canvas.height;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          ctx.drawImage(layer.canvas, offsetX + i * canvas.width, offsetY + j * canvas.height, canvas.width, canvas.height);
        }
      }
    });
    ctx.restore();
  }
};
starField.init();

function createSaleIndicator() {
  let indicator = document.getElementById("saleIndicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "saleIndicator";
    indicator.classList.add("sale-indicator");
    document.body.appendChild(indicator);
  }
}
function clearSaleIndicator() {
  const indicator = document.getElementById("saleIndicator");
  if (indicator) indicator.remove();
}

function checkAndSellUnprofitableBuildings() {
  gameState.buildings.forEach(building => {
    if (building.owner !== "ai" || ["base", "base2", "base3"].includes(building.type)) return;
    if (building.health < building.maxHealth * 0.5) {
      const nearbyRepairmen = getObjectsInRange({ x: building.x, y: building.y }, 100).filter(u => u.owner === "ai" && u.type === "repairman");
      if (nearbyRepairmen.length === 0 || gameState.aiResources.gold < 100 || gameState.aiResources.silicon < 100 || gameState.aiResources.plasma < 50) {
        queueSale(building);
      }
    }
  });
}

function spawnExplosionEffect(x, y) {
  gameState.particles.push({ x, y, vx: 0, vy: 0, life: 0.1, maxLife: 0.3, radius: 15, color: "#FF0000", flash: true });
  const particleCount = 15 + Math.floor(Math.random() * 10);
  for (let i = 0; i < particleCount; i++) {
    const angle = Math.random() * Math.PI * 2, speed = 80 + Math.random() * 80, life = 0.2 + Math.random() * 0.5;
    gameState.particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life, maxLife: life, radius: 2, color: "white", flash: false });
  }
}

function spawnSparkEffect(x, y) {
  const sparksCount = isMobile ? 2 : 4;
  for (let i = 0; i < sparksCount; i++) {
    const spark = getParticle();
    spark.x = x; spark.y = y;
    spark.vx = (Math.random() - 0.5) * 30; spark.vy = (Math.random() - 0.5) * 30;
    spark.life = spark.maxLife = 0.3 + Math.random() * 0.2;
    spark.type = "sparkLine"; spark.color = "rgba(255,255,255,1)";
    spark.length = 3 + Math.random() * 5; spark.thickness = 0.5 + Math.random() * 0.5;
    spark.angle = Math.random() * Math.PI * 2;
    gameState.particles.push(spark);
  }
}

function renderParticles() {
  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);
  renderShockZones();
  gameState.particles.forEach(p => {
    if (isInFogOfWar(p.x, p.y)) return;
    ctx.globalAlpha = p.life / p.maxLife;
    if (p.type === "laser") {
      const start = worldToScreen(p.x, p.y);
      const end = worldToScreen(p.x + Math.cos(p.angle) * p.length, p.y + Math.sin(p.angle) * p.length);
      ctx.strokeStyle = p.color; ctx.lineWidth = p.width * camera.scale;
      ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    } else if (p.type === "sparkLine") {
      ctx.strokeStyle = p.color; ctx.lineWidth = p.thickness;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(p.angle) * p.length, p.y + Math.sin(p.angle) * p.length); ctx.stroke();
    } else {
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  });
  ctx.restore();
}

function updateSaleIndicator() {
  const indicator = document.getElementById("saleIndicator");
  if (saleBuilding && indicator) {
    const elapsed = performance.now() - saleStartTime;
    const progress = Math.min(elapsed / saleDuration, 1);
    const screenPos = worldToScreen(saleBuilding.x, saleBuilding.y);
    indicator.style.left = (screenPos.x - (saleBuilding.width * camera.scale) / 2) + "px";
    indicator.style.top = (screenPos.y - (saleBuilding.height * camera.scale) / 2 - 10) + "px";
    indicator.style.width = (saleBuilding.width * camera.scale * progress) + "px";
    indicator.style.opacity = progress;
  }
}

function drawGoldPlanetAlt(resource, ctx) {
  ctx.save();
  let angle = resource.rotation || 0;
  resource.rotation = angle + 0.002;
  ctx.rotate(angle);
  const baseRadius = resource.baseRadius ? resource.baseRadius * 0.85 : 40;
  const oceanGradient = ctx.createRadialGradient(0, 0, baseRadius * 0.3, 0, 0, baseRadius);
  oceanGradient.addColorStop(0, "#fff8dc"); oceanGradient.addColorStop(0.5, "#ffd700"); oceanGradient.addColorStop(1, "#b8860b");
  ctx.fillStyle = oceanGradient; ctx.beginPath(); ctx.arc(0, 0, baseRadius, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, baseRadius, 0, Math.PI * 2); ctx.clip();
  if (resource.continents === undefined) {
    resource.continents = [];
    const continentCount = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < continentCount; i++) {
      let continent = {};
      continent.initialLongitude = Math.random() * 2 * Math.PI;
      continent.latitude = -0.4 + Math.random() * 0.8;
      continent.sizeFactor = 0.8 + Math.random() * 6;
      const vertexCount = 4 + Math.floor(Math.random() * 3);
      let shape = [];
      for (let j = 0; j < vertexCount; j++) {
        let theta = (j / vertexCount) * 2 * Math.PI + (Math.random() - 0.5) * 0.3;
        let rFactor = 0.3 + Math.random() * 0.4;
        shape.push({ x: rFactor * Math.cos(theta), y: rFactor * Math.sin(theta) });
      }
      continent.shape = shape; resource.continents.push(continent);
    }
  }
  const speed = 0.05, t = performance.now() / 1000;
  for (let i = 0; i < resource.continents.length; i++) {
    let continent = resource.continents[i];
    let newLongitude = continent.initialLongitude + speed * t;
    if (Math.cos(newLongitude) > 0) {
      let xCont = baseRadius * Math.cos(continent.latitude) * Math.sin(newLongitude);
      let yCont = baseRadius * Math.sin(continent.latitude);
      ctx.save(); ctx.translate(xCont, yCont);
      const scale = baseRadius * 0.2 * continent.sizeFactor;
      ctx.scale(scale, scale);
      ctx.fillStyle = "rgba(0, 0, 255,0.8)";
      let shape = continent.shape;
      ctx.beginPath(); ctx.moveTo(shape[0].x, shape[0].y);
      for (let j = 0; j < shape.length; j++) {
        let next = shape[(j + 1) % shape.length];
        let cpX = (shape[j].x + next.x) / 2 * (1 + 0.2);
        let cpY = (shape[j].y + next.y) / 2 * (1 + 0.2);
        ctx.quadraticCurveTo(cpX, cpY, next.x, next.y);
      }
      ctx.closePath(); ctx.fill(); ctx.restore();
    }
  }
  ctx.restore();
  ctx.lineWidth = 2; ctx.strokeStyle = "rgba(218,165,32,0.9)";
  ctx.beginPath(); ctx.arc(0, 0, baseRadius, 0, Math.PI * 2); ctx.stroke();
  const pulseRadius = baseRadius * 1.2;
  const pulseGrad = ctx.createRadialGradient(0, 0, baseRadius, 0, 0, pulseRadius);
  pulseGrad.addColorStop(0, "rgba(255,215,0,0.0)"); pulseGrad.addColorStop(1, "rgba(255,215,0,0.3)");
  ctx.fillStyle = pulseGrad; ctx.beginPath(); ctx.arc(0, 0, pulseRadius, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawSiliconPlanet(ctx, x, y, radius) {
  const gradient = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius);
  gradient.addColorStop(0, "#bbbbbb"); gradient.addColorStop(1, "#777777");
  ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = "#555";
  for (let i = 0; i < 3; i++) {
    const angle = (Math.PI * 2 * i) / 3 + performance.now() * 0.0002;
    ctx.beginPath();
    ctx.ellipse(x + Math.cos(angle) * radius * 0.5, y + Math.sin(angle) * radius * 0.5, radius * 0.2, radius * 0.1, angle, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(x, y, radius * 1.4, radius * 0.5, Math.PI / 6, 0, 2 * Math.PI); ctx.stroke();
}

function renderResource(resource) {
  ctx.save();
  ctx.translate(resource.x, resource.y);
  const now = performance.now(), sinValue = Math.sin(now / 300), pulse = (sinValue + 1) / 2;
  const pulseRadius = resource.baseRadius ? resource.baseRadius * 1.5 + pulse * 5 : 15;
  if (resource.type === "gold") { drawGoldPlanetAlt(resource, ctx); } 
  else if (resource.type === "silicon") {
    const size = 15;
    ctx.save(); ctx.rotate(performance.now() / 3000);
    const grad = ctx.createRadialGradient(0, 0, size * 0.2, 0, 0, size);
    grad.addColorStop(0, "#bbbbbb"); grad.addColorStop(1, "#777777");
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    if (resource.swirlCount === undefined) {
      resource.swirlCount = Math.floor(Math.random() * 5) + 1; resource.swirlOffsets = [];
      for (let i = 0; i < resource.swirlCount; i++) resource.swirlOffsets.push(Math.random() * Math.PI * 2);
      resource.swirlSizes = [];
      for (let i = 0; i < resource.swirlCount; i++) resource.swirlSizes.push((0.1 + Math.random() * 0.4) * size);
    }
    const baseAngle = performance.now() * 0.0005;
    for (let i = 0; i < resource.swirlCount; i++) {
      const angle = baseAngle + resource.swirlOffsets[i];
      const swirlX = Math.cos(angle) * size * 0.5, swirlY = Math.sin(angle) * size * 0.3;
      const t = performance.now() * 0.001, baseR = resource.swirlSizes[i];
      const dynamicR = baseR * (0.7 + 0.3 * Math.sin(t * 0.3 + i));
      let alpha = 1;
      if (swirlY > 0) alpha = Math.max(0, 1 - swirlY / (size * 0.3));
      ctx.fillStyle = `rgba(68,68,68,${alpha.toFixed(2)})`;
      ctx.beginPath(); ctx.arc(swirlX, swirlY, dynamicR, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(0, 0, size * 1.5, size * 0.8, Math.PI / 6, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(160,200,220,0.3)"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(0, 0, size * 1.8, size * 0.9, Math.PI / 5, 0, Math.PI * 2); ctx.stroke();
  } else if (resource.type === "plasma") {
    const baseRadius = 8;
    const time = performance.now(), swingAngle = Math.sin(time * 0.0004) * (Math.PI / 12);
    const dx = Math.cos(swingAngle) * baseRadius, dy = Math.sin(swingAngle) * baseRadius;
    const grad = ctx.createLinearGradient(-dx, -dy, dx, dy);
    grad.addColorStop(0.0, "#8a2be2"); grad.addColorStop(0.15, "#6a0dad"); grad.addColorStop(0.3, "#4b0082");
    grad.addColorStop(0.45, "#8a2be2"); grad.addColorStop(0.6, "#9370db"); grad.addColorStop(0.75, "#7b68ee");
    grad.addColorStop(0.9, "#6a0dad"); grad.addColorStop(1.0, "#8a2be2");
    if (!resource.cachedSatellites || (time - resource.lastSatUpdate > 50)) {
      if (resource.satelliteCount === undefined) {
        resource.satelliteCount = Math.floor(Math.random() * 3) + 1;
        resource.satelliteOffsets = []; resource.satelliteSizes = [];
        for (let i = 0; i < resource.satelliteCount; i++) {
          resource.satelliteOffsets.push(Math.random() * Math.PI * 2);
          resource.satelliteSizes.push(1.5 + Math.random() * 1.5);
        }
      }
      const rotationSpeed = 0.00015, currentRotation = time * rotationSpeed;
      const orbitMultiplierX = 2.0, orbitMultiplierY = 2.5;
      const satellites = [];
      for (let i = 0; i < resource.satelliteCount; i++) {
        const angle = currentRotation + resource.satelliteOffsets[i];
        const orbitX = Math.cos(angle) * baseRadius * orbitMultiplierX;
        const orbitY = Math.sin(angle) * baseRadius * orbitMultiplierY;
        const isBehind = orbitY > 0;
        const depthFactor = 1 - Math.abs(orbitY) / (baseRadius * orbitMultiplierY);
        const alpha = isBehind ? (0.3 + 0.4 * depthFactor) : (0.5 + 0.5 * depthFactor);
        const size = Math.max(0.5, resource.satelliteSizes[i] * (0.3 + 0.7 * depthFactor));
        satellites.push({ orbitX, orbitY, size, alpha, isBehind });
      }
      resource.cachedSatellites = satellites; resource.lastSatUpdate = time;
    }
    const backSatellites = resource.cachedSatellites.filter(s => s.isBehind);
    const frontSatellites = resource.cachedSatellites.filter(s => !s.isBehind);
    for (const sat of backSatellites) {
      ctx.fillStyle = `rgba(135,206,250,${sat.alpha.toFixed(2)})`;
      ctx.beginPath(); ctx.arc(sat.orbitX, sat.orbitY, sat.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, baseRadius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(135,206,250,0.3)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, baseRadius + 2, 0, Math.PI * 2); ctx.stroke();
    for (const sat of frontSatellites) {
      ctx.fillStyle = `rgba(135,206,250,${sat.alpha.toFixed(2)})`;
      ctx.beginPath(); ctx.arc(sat.orbitX, sat.orbitY, sat.size, 0, Math.PI * 2); ctx.fill();
    }
    const pulseGrad = ctx.createRadialGradient(0, 0, baseRadius, 0, 0, pulseRadius);
    pulseGrad.addColorStop(0, "rgba(148,0,211,0.0)"); pulseGrad.addColorStop(1, "rgba(148,0,211,0.4)");
    ctx.fillStyle = pulseGrad; ctx.beginPath(); ctx.arc(0, 0, pulseRadius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function findNearestResource(x, y, preferredType) {
  const pos = { x, y };
  let candidates = getObjectsInRange(pos, 1000).filter(r => r.amount > 0 && r.type === preferredType && r.currentWorkers < r.maxWorkers);
  if (candidates.length === 0) candidates = getObjectsInRange(pos, 1000).filter(r => r.amount > 0 && r.currentWorkers < r.maxWorkers);
  let nearest = null, minDist = Infinity;
  candidates.forEach(r => { const d = Math.hypot(r.x - x, r.y - y); if (d < minDist) { minDist = d; nearest = r; } });
  return nearest;
}

function renderWorkerResourceToken(ctx, token) {
  if (isInFogOfWar(token.x, token.y)) return;
  let baseColor, topColor, leftColor, rightColor;
  if (token.resourceType === "gold") { baseColor = "#ffd700"; topColor = "#fffacd"; leftColor = "#ffd700"; rightColor = "#b8860b"; } 
  else if (token.resourceType === "silicon") { baseColor = "silver"; topColor = "#d3d3d3"; leftColor = "silver"; rightColor = "#a9a9a9"; } 
  else if (token.resourceType === "plasma") { baseColor = "cyan"; topColor = "#e0ffff"; leftColor = "cyan"; rightColor = "#008b8b"; } 
  else { baseColor = "white"; topColor = "#ffffff"; leftColor = "#cccccc"; rightColor = "#999999"; }
  const size = 6, half = size / 3, offset = 1;
  ctx.beginPath(); ctx.moveTo(token.x, token.y - half - offset); ctx.lineTo(token.x + half, token.y - offset);
  ctx.lineTo(token.x, token.y + half - offset); ctx.lineTo(token.x - half, token.y - offset); ctx.closePath(); ctx.fillStyle = topColor; ctx.fill();
  ctx.beginPath(); ctx.moveTo(token.x - half, token.y - offset); ctx.lineTo(token.x, token.y + half - offset);
  ctx.lineTo(token.x, token.y + half + offset); ctx.lineTo(token.x - half, token.y + offset); ctx.closePath(); ctx.fillStyle = leftColor; ctx.fill();
  ctx.beginPath(); ctx.moveTo(token.x + half, token.y - offset); ctx.lineTo(token.x, token.y + half - offset);
  ctx.lineTo(token.x, token.y + half + offset); ctx.lineTo(token.x + half, token.y + offset); ctx.closePath(); ctx.fillStyle = rightColor; ctx.fill();
}

function renderResourceTokens() {
  ctx.save(); ctx.fillStyle = "gold";
  gameState.resourceTokens.forEach(token => {
    if (isInFogOfWar(token.x, token.y)) return;
    const screenPos = worldToScreen(token.x, token.y);
    ctx.beginPath(); ctx.arc(screenPos.x, screenPos.y, 3, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();
}

function spawnParticles(x, y, color) {
  const count = Math.floor(Math.random() * 3) + 3;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2, speed = Math.random() * 50 + 50;
    const particle = { x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0.2 + Math.random() * 0.5, maxLife: 0, color: "yellow", radius: 1 };
    particle.maxLife = particle.life;
    gameState.particles.push(particle);
  }
}

function getMarkerPosition(offset, rect) {
  const w = rect.width, h = rect.height, perimeter = 2 * (w + h);
  let pos = offset % perimeter;
  if (pos < w) return { x: rect.x + pos, y: rect.y };
  if (pos < w + h) return { x: rect.x + w, y: rect.y + (pos - w) };
  if (pos < 2 * w + h) return { x: rect.x + w - (pos - (w + h)), y: rect.y + h };
  return { x: rect.x, y: rect.y + h - (pos - (2 * w + h)) };
}

function spawnShockEffect(x, y) {
  const count = isMobile ? 2 : 4;
  for (let i = 0; i < count; i++) {
    const p = getParticle();
    p.x = x; p.y = y; p.vx = (Math.random() - 0.5) * 40; p.vy = (Math.random() - 0.5) * 40;
    p.life = p.maxLife = 0.3 + Math.random() * 0.3; p.type = "sparkLine"; p.color = "cyan";
    p.length = 3 + Math.random() * 5; p.thickness = 1; p.angle = Math.random() * Math.PI * 2;
    gameState.particles.push(p);
  }
}

let backgroundCache;
function createBackgroundCache() {
  backgroundCache = document.createElement('canvas');
  backgroundCache.width = canvas.width; backgroundCache.height = canvas.height;
  let bgCtx = backgroundCache.getContext('2d');
  bgCtx.fillStyle = "#000"; bgCtx.fillRect(0, 0, backgroundCache.width, backgroundCache.height);
  bgCtx.fillStyle = "white";
  for (let i = 0; i < (isMobile ? 50 : 100); i++) {
    bgCtx.beginPath(); bgCtx.arc(Math.random() * backgroundCache.width, Math.random() * backgroundCache.height, 1.5, 0, Math.PI * 2); bgCtx.fill();
  }
}

function drawCapturePoints() {
  gameState.capturePoints.forEach(cp => {
    ctx.save();
    const screenPos = worldToScreen(cp.x, cp.y);
    ctx.fillStyle = cp.color;
    ctx.fillRect(screenPos.x - (cp.width * camera.scale) / 2, screenPos.y - (cp.height * camera.scale) / 2, cp.width * camera.scale, cp.height * camera.scale);
    ctx.restore();
  });
}

// ============================================================
// ОТРИСОВКА ЭФФЕКТОВ ПЕРКОВ
// ============================================================
function renderShockZones() {
  const now = performance.now();
  shockZones = shockZones.filter(zone => {
    // 🔥 ЗАЩИТА: проверяем, что zone и его координаты существуют
    if (!zone || typeof zone.x !== 'number' || typeof zone.y !== 'number') {
      return false;
    }
    
    const elapsed = now - zone.start;
    if (elapsed > 2000) return false;

    const progress = elapsed / 2000;
    zone.radius = zone.maxRadius * progress;
    const alpha = 1 - progress;

    ctx.save();

    // Внешнее свечение
    const glowGrad = ctx.createRadialGradient(zone.x, zone.y, 0, zone.x, zone.y, zone.radius);
    glowGrad.addColorStop(0, `rgba(0, 255, 255, ${alpha * 0.3})`);
    glowGrad.addColorStop(0.7, `rgba(0, 200, 255, ${alpha * 0.15})`);
    glowGrad.addColorStop(1, `rgba(0, 150, 255, 0)`);
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.fill();

    // Кольцо волны
    ctx.strokeStyle = `rgba(0, 255, 255, ${alpha})`;
    ctx.lineWidth = 3;
    ctx.shadowColor = "#00ffff";
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.stroke();

    // 🔥 ИСПРАВЛЕНИЕ: Рисуем молнии корректно
    if (zone.lightningBolts && Array.isArray(zone.lightningBolts)) {
      zone.lightningBolts.forEach(boltObj => {
        // boltObj - это объект { points: [...], life: ... }
        // Поэтому берем boltObj.points, а не boltObj[0]
        const pts = boltObj.points;
        if (!pts || pts.length === 0) return;
        
        ctx.strokeStyle = `rgba(200, 255, 255, ${alpha * 0.9})`;
        ctx.lineWidth = 2;
        ctx.shadowColor = "#ffffff";
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y); // <-- Здесь была ошибка!
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
      });
    }

    ctx.restore();
    return true;
  });
}

function renderBombZones() {
  const now = performance.now();
  bombZones = bombZones.filter(zone => {
    const elapsed = now - zone.start;

    if (!zone.exploded) {
      // Фаза предупреждения — пульсирующая зона
      const warningProgress = elapsed / zone.warningTime;
      const pulse = Math.sin(warningProgress * Math.PI * 4) * 0.5 + 0.5;
      const currentRadius = zone.maxRadius * (0.3 + warningProgress * 0.7);

      ctx.save();

      // Красное предупреждающее свечение
      const warnGrad = ctx.createRadialGradient(zone.x, zone.y, 0, zone.x, zone.y, currentRadius);
      warnGrad.addColorStop(0, `rgba(255, 50, 0, ${0.4 + pulse * 0.3})`);
      warnGrad.addColorStop(0.6, `rgba(255, 100, 0, ${0.2 + pulse * 0.2})`);
      warnGrad.addColorStop(1, `rgba(255, 0, 0, 0)`);
      ctx.fillStyle = warnGrad;
      ctx.beginPath();
      ctx.arc(zone.x, zone.y, currentRadius, 0, Math.PI * 2);
      ctx.fill();

      // Пульсирующее кольцо
      ctx.strokeStyle = `rgba(255, ${100 - pulse * 100}, 0, ${0.8 + pulse * 0.2})`;
      ctx.lineWidth = 2 + pulse * 2;
      ctx.shadowColor = "#ff4400";
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(zone.x, zone.y, currentRadius, 0, Math.PI * 2);
      ctx.stroke();

      // Таймер в центре
      const remaining = Math.max(0, (zone.warningTime - elapsed) / 1000);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px Orbitron";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "#ff0000";
      ctx.shadowBlur = 10;
      ctx.fillText(remaining.toFixed(1), zone.x, zone.y);

      ctx.restore();
      return true;
    } else {
      // Фаза взрыва — расширяющееся кольцо
      const explosionProgress = Math.min(1, (elapsed - zone.warningTime) / 1000);
      const alpha = 1 - explosionProgress;

      ctx.save();

      const expGrad = ctx.createRadialGradient(zone.x, zone.y, 0, zone.x, zone.y, zone.maxRadius * explosionProgress);
      expGrad.addColorStop(0, `rgba(255, 255, 200, ${alpha})`);
      expGrad.addColorStop(0.3, `rgba(255, 150, 0, ${alpha * 0.8})`);
      expGrad.addColorStop(0.7, `rgba(255, 50, 0, ${alpha * 0.4})`);
      expGrad.addColorStop(1, `rgba(255, 0, 0, 0)`);
      ctx.fillStyle = expGrad;
      ctx.beginPath();
      ctx.arc(zone.x, zone.y, zone.maxRadius * explosionProgress, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      return explosionProgress < 1;
    }
  });
}

function renderReconZones() {
  const now = Date.now();
  reconZones = reconZones.filter(zone => {
    const elapsed = now - zone.start;
    if (elapsed > zone.duration) return false;

    const progress = elapsed / zone.duration;
    const alpha = 1 - progress;
    zone.radius = zone.maxRadius * Math.min(1, progress * 3); // Быстрое расширение
    zone.scanAngle = (zone.scanAngle || 0) + 0.05;

    ctx.save();

    // Сканирующая волна
    const scanGrad = ctx.createRadialGradient(zone.x, zone.y, 0, zone.x, zone.y, zone.radius);
    scanGrad.addColorStop(0, `rgba(0, 255, 150, ${alpha * 0.1})`);
    scanGrad.addColorStop(0.8, `rgba(0, 255, 150, ${alpha * 0.3})`);
    scanGrad.addColorStop(1, `rgba(0, 255, 150, 0)`);
    ctx.fillStyle = scanGrad;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.fill();

    // Вращающийся сканер
    ctx.strokeStyle = `rgba(0, 255, 150, ${alpha * 0.6})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = "#00ff88";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(zone.x, zone.y);
    ctx.lineTo(
      zone.x + Math.cos(zone.scanAngle) * zone.radius,
      zone.y + Math.sin(zone.scanAngle) * zone.radius
    );
    ctx.stroke();

    // Кольцо
    ctx.strokeStyle = `rgba(0, 255, 150, ${alpha * 0.4})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
    return true;
  });
}

function spawnSupernovaEffect(obj) {
  // Простой визуальный эффект исчезновения ресурса или взрыва бомбы
  for (let i = 0; i < 20; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 50 + Math.random() * 100;
    gameState.particles.push({
      x: obj.x, y: obj.y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 1.0, maxLife: 1.0, radius: 3,
      color: obj.color || "#ffffff", type: "spark"
    });
  }
}

const warehouseImage = new Image(); warehouseImage.src = "/src/models/warehouse.png"; warehouseImage.onload = () => { preloadedIcons["warehouse"] = warehouseImage; };
const repairWorkshopImage = new Image(); repairWorkshopImage.src = "/src/models/repairWorkshop.png"; repairWorkshopImage.onload = () => { preloadedIcons["repairWorkshop"] = repairWorkshopImage; };
const beaconImage = new Image(); beaconImage.src = "/src/models/beacon.png"; beaconImage.onload = () => { preloadedIcons["beacon"] = beaconImage; };
const baseImage = new Image(); baseImage.src = "/src/models/base.png"; baseImage.onload = () => { preloadedIcons["base"] = baseImage; };
const base2Image = new Image(); base2Image.src = "/src/models/base2.png"; base2Image.onload = () => { preloadedIcons["base2"] = base2Image; };
const base3Image = new Image(); base3Image.src = "/src/models/base3.png"; base3Image.onload = () => { preloadedIcons["base3"] = base3Image; };
const barracksImage = new Image(); barracksImage.src = "/src/models/barracks.png"; barracksImage.onload = () => { preloadedIcons["barracks"] = barracksImage; };
const barracks2Image = new Image(); barracks2Image.src = "/src/models/barracks2.png"; barracks2Image.onload = () => { preloadedIcons["barracks2"] = barracks2Image; };
const barracks3Image = new Image(); barracks3Image.src = "/src/models/barracks3.png"; barracks3Image.onload = () => { preloadedIcons["barracks3"] = barracks3Image; };

// ============================================================
// ОТРИСОВКА ТУМАНА ВОЙНЫ
// ============================================================
function renderPersistentFog() {
  // Защита от ошибок, если массивы еще не инициализированы
  if (!fogMap || !fogMap.length || !persistentFogMap || !persistentFogMap.length) return;
  
  ctx.save();
  const cellScreenSize = FOG_CELL_SIZE * camera.scale;
  const invScale = 1 / camera.scale;
  
  // Вычисляем видимую область экрана в мировых координатах
  const viewLeft = -camera.offsetX * invScale;
  const viewTop = -camera.offsetY * invScale;
  const viewRight = viewLeft + canvas.width * invScale;
  const viewBottom = viewTop + canvas.height * invScale;
  
  const startCol = Math.max(0, Math.floor(viewLeft / FOG_CELL_SIZE));
  const endCol = Math.min(persistentFogMap[0].length - 1, Math.floor(viewRight / FOG_CELL_SIZE));
  const startRow = Math.max(0, Math.floor(viewTop / FOG_CELL_SIZE));
  const endRow = Math.min(persistentFogMap.length - 1, Math.floor(viewBottom / FOG_CELL_SIZE));
  
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      // Проверка на существование ячейки
      if (!persistentFogMap[r] || persistentFogMap[r][c] === undefined) continue;
      
      const worldX = c * FOG_CELL_SIZE;
      const worldY = r * FOG_CELL_SIZE;
      const screenPos = worldToScreen(worldX, worldY);
      
      if (persistentFogMap[r][c] === 0) {
        // 🔥 ПОЛНАЯ ТЬМА (территория еще не исследована)
        ctx.fillStyle = "rgba(0, 0, 0, 0.95)";
        // +1 пиксель, чтобы избежать микро-щелей между квадратами при зуме
        ctx.fillRect(screenPos.x, screenPos.y, cellScreenSize + 1, cellScreenSize + 1); 
      } else if (fogMap[r] && fogMap[r][c] === 0) {
        // 🔥 ТУМАН ВОЙНЫ (территория исследована, но сейчас не видна)
        ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        ctx.fillRect(screenPos.x, screenPos.y, cellScreenSize + 1, cellScreenSize + 1);
      }
    }
  }
  ctx.restore();
}

function renderFogOfWar() {
  renderPersistentFog();
}

function renderGame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!backgroundCache) createBackgroundCache();
  ctx.drawImage(backgroundCache, 0, 0);
  if (backgroundImage.complete) ctx.drawImage(backgroundImage, 0, canvas.height - backgroundImage.height, backgroundImage.width, backgroundImage.height);
  starField.draw();
  ctx.save();
  ctx.translate(camera.offsetX, camera.offsetY);
  ctx.scale(camera.scale, camera.scale);
  
  gameState.resources.forEach(resource => renderResource(resource));
  
  gameState.buildings.forEach(building => {
    ctx.save();
    ctx.translate(building.x, building.y);
    const glowRadius = 42 * 0.7;
    const baseColor = OWNER_COLORS[building.owner]?.base || "#ffffff";
    const ownerGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
    ownerGlow.addColorStop(0, hexToRgba(baseColor, 0.35)); ownerGlow.addColorStop(1, hexToRgba(baseColor, 0.0));
    ctx.fillStyle = ownerGlow; ctx.beginPath(); ctx.arc(0, 0, glowRadius, 0, Math.PI * 2); ctx.fill();
    
    if (!building.active) {
      const portalRadius = Math.sqrt(Math.pow(building.width, 2) + Math.pow(building.height, 2)) / 2 + 10;
      const gradient = ctx.createRadialGradient(0, 0, portalRadius * 0.1, 0, 0, portalRadius);
      gradient.addColorStop(0, "rgba(255,0,0,0.9)"); gradient.addColorStop(0.3, "rgba(255,80,80,0.7)");
      gradient.addColorStop(0.5, "rgba(100,180,220,0.5)"); gradient.addColorStop(0.7, "rgba(0,180,240,0.3)");
      gradient.addColorStop(1, "rgba(0,180,240,0)");
      ctx.globalCompositeOperation = "lighter"; ctx.shadowColor = "rgba(0,180,240,0.8)"; ctx.shadowBlur = 20;
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(0, 0, portalRadius, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalCompositeOperation = "source-over";
    }
    
    ctx.globalAlpha = building.active ? 1 : 0.1;

    // === ОТРИСОВКА ЗДАНИЙ ===
if (building.type === "turret") {
  ctx.scale(0.8, 0.8);
  const now = performance.now();
  const angle = building.angle;
  const isFiring = (now - building.lastFireTime) < 200;
  
  // Основание
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const x = 12 * Math.cos(a);
    const y = 12 * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const hexColor = OWNER_COLORS[building.owner]?.accent || "#ffffff";
  ctx.fillStyle = hexColor;
  ctx.fill();
  ctx.restore();
  
  // Башня
  ctx.rotate(angle);
  const pyramidSize = 12;
  const pyramidColors = ["#666", "#444", "#333", "#555"];
  for (let i = 0; i < 4; i++) {
    const a1 = (Math.PI / 2) * i;
    const a2 = (Math.PI / 2) * (i + 1);
    const x1 = pyramidSize * Math.cos(a1);
    const y1 = pyramidSize * Math.sin(a1);
    const x2 = pyramidSize * Math.cos(a2);
    const y2 = pyramidSize * Math.sin(a2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.closePath();
    ctx.fillStyle = pyramidColors[i];
    ctx.fill();
  }
  
  // Ствол
  ctx.fillStyle = "#778899";
  ctx.fillRect(8, -2, 10, 3);
  if (isFiring) {
    ctx.fillStyle = "rgba(255, 80, 0, 0.8)";
    ctx.fillRect(18, -2, 4, 3);
  }
}
else if (building.type === "turret2") {
  ctx.scale(0.8, 0.8);
  ctx.rotate(building.angle);
  
  // Основание
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const x = 12 * Math.cos(a);
    const y = 12 * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = OWNER_COLORS[building.owner]?.accent || "#ffffff";
  ctx.fill();
  ctx.restore();
  
  // Пусковая установка
  ctx.fillStyle = "#666";
  ctx.fillRect(-5, -14, 10, 6);
  
  // Ракеты
  ctx.fillStyle = "#ffaa00";
  for (let i = -1; i <= 1; i++) {
    ctx.fillRect(-3, -14 + i * 5, 6, 3);
  }
}
else if (building.type === "turret3") {
  ctx.scale(0.8, 0.8);
  ctx.rotate(building.angle);
  
  // Основание
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const x = 12 * Math.cos(a);
    const y = 8 * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = OWNER_COLORS[building.owner]?.hull || "#666";
  ctx.fill();
  
  // Реактор
  ctx.fillStyle = "rgba(255, 40, 40, 0.6)";
  ctx.beginPath();
  ctx.ellipse(-12, 0, 4, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  
  // Ствол
  ctx.fillStyle = building.charge > 400 ? "#ffeeaa" : "#555";
  ctx.fillRect(6, -1.5, 10, 3);
}
else if (building.type === "beacon") {
  const time = performance.now() / 1000;
  const angle = Math.sin(time * 0.3) * 0.1;
  ctx.rotate(angle);
  const scale = 1 + Math.sin(time * 0.5) * 0.1;
  ctx.scale(scale, scale);
  
  const baseWidth = 32;
  const aspectRatio = 40 / 64;
  const baseHeight = baseWidth * aspectRatio;
  const baseUnit = baseWidth / 32;
  const half = baseHeight / 2;
  
  const image = preloadedIcons["beacon"];
  if (image && image.complete) {
    ctx.drawImage(image, -baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
  } else {
    ctx.fillStyle = OWNER_COLORS[building.owner]?.accent || "#888";
    ctx.fillRect(-baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
  }
  
  // Диоды
  if (Math.floor(performance.now() / 800) % 2 === 0) {
    ctx.fillStyle = OWNER_COLORS[building.owner]?.accent || "#ffffff";
    ctx.beginPath();
    ctx.arc(0 * baseUnit, (-half + 1) * baseUnit, 0.6 * baseUnit, 0, Math.PI * 2);
    ctx.arc(4 * baseUnit, (-half + 11) * baseUnit, 0.6 * baseUnit, 0, Math.PI * 2);
    ctx.fill();
  }
}
else if (building.type === "base" || building.type === "base2" || building.type === "base3") {
  const time = performance.now() / 1000;
  const angle = Math.sin(time * 0.3) * 0.1;
  ctx.rotate(angle);
  const scale = 1 + Math.sin(time * 0.5) * 0.1;
  ctx.scale(scale, scale);
  
  const baseWidth = 72;
  const aspectRatio = 60 / 84;
  const baseHeight = baseWidth * aspectRatio;
  const baseUnit = baseWidth / 72;
  const half = baseHeight / 2;
  
  const imageName = building.type === "base" ? "base" : building.type === "base2" ? "base2" : "base3";
  const image = preloadedIcons[imageName];
  
  if (image && image.complete) {
    ctx.drawImage(image, -baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
  } else {
    ctx.fillStyle = OWNER_COLORS[building.owner]?.accent || "#888";
    ctx.fillRect(-baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
  }
  
  // Окна
  const cockpitBlink = Math.sin(performance.now() / 200) * 0.1 + 0.4;
  const glowRGB = hexToRgb(OWNER_COLORS[building.owner]?.base || "#00ffff");
  ctx.fillStyle = "rgba(" + glowRGB + ", " + cockpitBlink + ")";
  
  ctx.beginPath();
  ctx.moveTo(7 * baseUnit, -half + 8 * baseUnit);
  ctx.lineTo(9 * baseUnit, -half + 8 * baseUnit);
  ctx.lineTo(8.5 * baseUnit, -half + 6.5 * baseUnit);
  ctx.lineTo(7.5 * baseUnit, -half + 6.5 * baseUnit);
  ctx.closePath();
  ctx.fill();
  
  // Реактор
  const coreAlpha = Math.sin(performance.now() / 600) * 0.1 + 0.3;
  ctx.fillStyle = "rgba(255, 0, 0, " + coreAlpha + ")";
  ctx.beginPath();
  ctx.ellipse(13, 3, 2.3 * baseUnit, 1.2 * baseUnit, 0, 0, Math.PI * 2);
  ctx.fill();
}
else if (building.type === "barracks" || building.type === "barracks2" || building.type === "barracks3") {
  const time = performance.now() / 1000;
  const angle = Math.sin(time * 0.3) * 0.1;
  ctx.rotate(angle);
  const scale = 1 + Math.sin(time * 0.5) * 0.1;
  ctx.scale(scale, scale);
  
  const size = 52;
  const half = size / 2;
  const baseUnit = size / 52;
  
  const imageName = building.type === "barracks" ? "barracks" : building.type === "barracks2" ? "barracks2" : "barracks3";
  const image = preloadedIcons[imageName];
  
  if (image && image.complete) {
    ctx.drawImage(image, -half, -half, size, size);
  } else {
    ctx.fillStyle = OWNER_COLORS[building.owner]?.hull || "#666";
    ctx.fillRect(-half, -half, size, size);
  }
  
  // Окна
  const cockpitBlink = Math.sin(performance.now() / 200) * 0.1 + 0.7;
  const glowRGB = hexToRgb(OWNER_COLORS[building.owner]?.base || "#00ffff");
  ctx.fillStyle = "rgba(" + glowRGB + ", " + cockpitBlink + ")";
  
  ctx.beginPath();
  ctx.moveTo(7 * baseUnit, -half + 8 * baseUnit);
  ctx.lineTo(9 * baseUnit, -half + 8 * baseUnit);
  ctx.lineTo(8.5 * baseUnit, -half + 6.5 * baseUnit);
  ctx.lineTo(7.5 * baseUnit, -half + 6.5 * baseUnit);
  ctx.closePath();
  ctx.fill();
}
else if (building.type === "warehouse") {
  const time = performance.now() / 1000;
  const angle = Math.sin(time * 0.3) * 0.1;
  ctx.rotate(angle);
  const scale = 1 + Math.sin(time * 0.5) * 0.1;
  ctx.scale(scale, scale);
  
  const size = 42;
  const half = size / 2;
  const baseUnit = size / 42;
  
  const image = preloadedIcons["warehouse"];
  if (image && image.complete) {
    ctx.drawImage(image, -half, -half, size, size);
  } else {
    ctx.fillStyle = "#333";
    ctx.fillRect(-half, -half, size, size);
  }
  
  // Индикатор рабочих
  const indicatorWidth = size / 2;
  const indicatorHeight = 3;
  const indicatorY = half + 2;
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(-indicatorWidth / 2, indicatorY, indicatorWidth, indicatorHeight);
  
  const segments = 5;
  const segWidth = indicatorWidth / segments;
  const filled = Math.min(segments, building.workers || 0);
  ctx.fillStyle = building.owner === playerId ? "lightgreen" : "red";
  
  for (let i = 0; i < filled; i++) {
    ctx.fillRect(-indicatorWidth / 2 + i * segWidth, indicatorY, segWidth - 1, indicatorHeight);
  }
  
  // Крышка
  if (building.lidOpenUntil && performance.now() < building.lidOpenUntil) {
    const progress = 1 - (building.lidOpenUntil - performance.now()) / 400;
    const lidSize = (2 + progress * 2) * baseUnit;
    const w = lidSize, h = lidSize * 0.5, lift = lidSize * 0.2;
    
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(w / 2, -h / 2 - lift);
    ctx.lineTo(w / 2, h / 2);
    ctx.lineTo(-w / 2, h / 2);
    ctx.closePath();
    ctx.fill();
  }
}
else if (building.type === "repairWorkshop") {
  const time = performance.now() / 1000;
  const angle = Math.sin(time * 0.3) * 0.1;
  ctx.rotate(angle);
  const scale = 1 + Math.sin(time * 0.5) * 0.1;
  ctx.scale(scale, scale);
  
  const size = 42;
  const half = size / 2;
  const baseUnit = size / 42;
  
  const image = preloadedIcons["repairWorkshop"];
  if (image && image.complete) {
    ctx.drawImage(image, -half, -half, size, size);
  } else {
    ctx.fillStyle = OWNER_COLORS[building.owner]?.hull || "#666";
    ctx.fillRect(-half, -half, size, size);
  }
  
  // Индикатор ремонтников
  const indicatorWidth = size / 2;
  const indicatorHeight = 3;
  const indicatorY = half + 2;
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fillRect(-indicatorWidth / 2, indicatorY, indicatorWidth, indicatorHeight);
  
  const segments = 5;
  const segWidth = indicatorWidth / segments;
  const filled = Math.min(segments, building.repairman || 0);
  ctx.fillStyle = OWNER_COLORS[building.owner]?.base === "#00ccff" ? "lightgreen" : "red";
  
  for (let i = 0; i < filled; i++) {
    ctx.fillRect(-indicatorWidth / 2 + i * segWidth, indicatorY, segWidth - 1, indicatorHeight);
  }
}
else {
  ctx.fillStyle = building.owner === playerId ? "rgba(0,128,255,0.7)" : "rgba(255,128,0,0.7)";
  ctx.fillRect(-building.width / 2, -building.height / 2, building.width, building.height);
}
    
    if (building.health < building.maxHealth) {
      const barHeight = 4, barWidth = building.width;
      ctx.globalAlpha = 1; ctx.fillStyle = "rgba(165, 42, 42,1)";
      ctx.fillRect(-barWidth / 2, -building.height / 2 - barHeight - 2, barWidth, barHeight);
      ctx.fillStyle = "green";
      ctx.fillRect(-barWidth / 2, -building.height / 2 - barHeight - 2, barWidth * (Math.max(0, building.health) / building.maxHealth), barHeight);
    }
    ctx.restore();
  });

  gameState.units.forEach(unit => {
    if (unit.hidden) return;
    ctx.save();
    ctx.translate(unit.x, unit.y);
    ctx.scale(unit.scale, unit.scale);
    if (["fighter", "worker", "repairman", "assault", "elite"].includes(unit.type)) {
      const isCombat = ["fighter", "assault", "elite"].includes(unit.type);
      const flameLength = isCombat ? 12 + Math.random() * 6 : 6 + Math.random() * 3;
      const flameWidth = isCombat ? 4 + Math.random() * 2 : 2 + Math.random() * 1;
      const flameAlpha = isCombat ? 0.5 + Math.random() * 0.4 : 0.2 + Math.random() * 0.2;
      ctx.save(); ctx.rotate(unit.angle);
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-flameLength * 0.1, -flameWidth * 0.4, -flameLength * 0.3, -flameWidth * 0.5, -flameLength, 0);
      ctx.bezierCurveTo(-flameLength * 0.3, flameWidth * 0.5, -flameLength * 0.1, flameWidth * 0.4, 0, 0);
      ctx.fillStyle = `rgba(255, 100, 0, ${flameAlpha})`; ctx.fill();
      const coreLength = flameLength * 0.7, coreWidth = flameWidth * 0.5, coreAlpha = flameAlpha * 1;
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.bezierCurveTo(-coreLength * 0.3, -coreWidth * 0.6, -coreLength * 0.7, -coreWidth * 0.8, -coreLength, 0);
      ctx.bezierCurveTo(-coreLength * 0.7, coreWidth * 0.8, -coreLength * 0.3, coreWidth * 0.6, 0, 0);
      ctx.fillStyle = `rgba(100, 200, 255, ${Math.min(coreAlpha, 1)})`; ctx.fill();
      ctx.restore();
    }
    ctx.rotate(unit.angle);
    if (unit.burning) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 100);
      ctx.strokeStyle = `rgba(255, 0, 0, ${pulse.toFixed(2)})`; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.stroke();
      if (Math.random() < 0.2) {
        gameState.particles.push({ x: unit.x + (Math.random() - 0.5) * 8, y: unit.y - 6 + (Math.random() - 0.5) * 4, vx: 0, vy: -0.2 - Math.random() * 0.2, life: 0.5, maxLife: 0.5, color: "rgba(80, 80, 80, 0.3)" });
      }
    }
// === ОТРИСОВКА ЮНИТОВ ===
const image = preloadedIcons["src/models/" + unit.type + ".png"];

if (unit.type === "worker") {
  ctx.rotate(-Math.PI / 2);
  const scaleFactor = 0.8;
  ctx.scale(scaleFactor, scaleFactor);
  const idleOffset = unit.commandQueue.length === 0 ? Math.sin(unit.idleTimer) * 2 : 0;
  ctx.translate(0, idleOffset);
  
  const width = 10, height = 10;
  if (image && image.complete) {
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
  } else {
    ctx.fillStyle = "#00FF00";
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  
  ctx.rotate(-Math.PI / 2);
  const accentColor = OWNER_COLORS[unit.owner]?.accent || "#00ffff";
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.ellipse(3, 0, 1.3, 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-1, -0.8, 1, 1.4);
}
else if (unit.type === "repairman") {
  ctx.rotate(-Math.PI / 2);
  const scaleFactor = 0.8;
  ctx.scale(scaleFactor, scaleFactor);
  const idleOffset = unit.commandQueue.length === 0 ? Math.sin(unit.idleTimer) * 2 : 0;
  ctx.translate(0, idleOffset);
  
  const width = 10, height = 10;
  if (image && image.complete) {
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
  } else {
    ctx.fillStyle = "#0000FF";
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  
  ctx.rotate(-Math.PI / 2);
  const accentColor = OWNER_COLORS[unit.owner]?.accent || "#00ffff";
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.ellipse(3, 0, 1.3, 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(-Math.PI / 1.3);
  ctx.fillRect(2, 0.5, 0.5, 1);
}
else if (unit.type === "fighter") {
  const accentColor = OWNER_COLORS[unit.owner]?.accent || "#ffffff";
  ctx.rotate(Math.PI / 2);
  const scaleFactor = 0.3;
  ctx.scale(scaleFactor, scaleFactor);
  const idleOffset = unit.commandQueue.length === 0 ? Math.sin(unit.idleTimer) * 4 : 0;
  ctx.translate(0, idleOffset);
  
  const width = 50, height = 50;
  if (image && image.complete) {
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
  } else {
    ctx.fillStyle = "#FF0000";
    ctx.beginPath();
    ctx.moveTo(0, -15);
    ctx.lineTo(-10, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(10, 10);
    ctx.closePath();
    ctx.fill();
  }
  
  ctx.save();
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.ellipse(10, 0, 3.5, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-15, -9, 10, 1.5);
  ctx.fillRect(-15, 7.5, 10, 1.5);
  ctx.fillRect(-24, -1, 4, 2);
  ctx.restore();
}
else if (unit.type === "assault") {
  const accentColor = OWNER_COLORS[unit.owner]?.accent || "#ffffff";
  ctx.rotate(-Math.PI / 2);
  const scaleFactor = 0.3;
  ctx.scale(scaleFactor, scaleFactor);
  const idleOffset = unit.commandQueue.length === 0 ? Math.sin(unit.idleTimer) * 4 : 0;
  ctx.translate(0, idleOffset);
  
  const width = 50, height = 50;
  if (image && image.complete) {
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
  } else {
    ctx.fillStyle = "#800080";
    ctx.beginPath();
    ctx.moveTo(0, -15);
    ctx.lineTo(-12, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(12, 10);
    ctx.closePath();
    ctx.fill();
  }
  
  ctx.save();
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.ellipse(7, 0, 3.5, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-5, -9, 10, 1.5);
  ctx.fillRect(-5, 7.5, 10, 1.5);
  ctx.fillRect(-3, -8, 8, 1.5);
  ctx.fillRect(-3, 6.5, 8, 1.5);
  ctx.fillRect(0, -1, 4, 2);
  ctx.restore();
}
else if (unit.type === "elite") {
  const accentColor = OWNER_COLORS[unit.owner]?.accent || "#00ffff";
  ctx.rotate(Math.PI / 2);
  const scaleFactor = 0.13;
  ctx.scale(scaleFactor, scaleFactor);
  const idleOffset = unit.commandQueue.length === 0 ? Math.sin(unit.idleTimer) * 3 : 0;
  ctx.translate(0, idleOffset);
  
  const width = 180, height = 300;
  if (image && image.complete) {
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
  } else {
    ctx.fillStyle = "#808080";
    ctx.beginPath();
    ctx.moveTo(0, -30);
    ctx.lineTo(-20, 20);
    ctx.lineTo(0, 10);
    ctx.lineTo(20, 20);
    ctx.closePath();
    ctx.fill();
  }
  
  ctx.save();
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.ellipse(20, 0, 8, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(-120, -14, 20, 2);
  ctx.fillRect(-120, 12, 20, 2);
  ctx.fillRect(-180, -2, 8, 4);
  ctx.restore();
}
    
    if (unit.owner === playerId && (unit.type === "fighter" || unit.type === "assault" || unit.type === "elite") && unit.group !== undefined && unit.group !== null) {
      let markerColor = "yellow";
      if (unit.group === 1) markerColor = "red";
      else if (unit.group === 2) markerColor = "green";
      else if (unit.group === 3) markerColor = "blue";
      const offsetY = unit.height ? (-unit.height / 2 - 10) : (-(unit.radius || 5) - 10);
      ctx.fillStyle = markerColor; ctx.beginPath(); ctx.arc(0, offsetY, 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    if (selectedUnits.includes(unit)) drawCircularHP(unit.x, unit.y, 10, unit.health, unit.maxHealth);
    if (unit.formationBuff) {
      ctx.save();
      const t = performance.now(), pulse = 0.5 + 0.5 * Math.sin(t / 200);
      if (unit.formationBuff.type === "speed") { ctx.beginPath(); ctx.arc(unit.x, unit.y, 12, 0, Math.PI * 2); ctx.strokeStyle = `rgba(0,255,255,${0.2 + 0.3 * pulse})`; ctx.lineWidth = 1.5; ctx.stroke(); } 
      else if (unit.formationBuff.type === "hp") { ctx.beginPath(); ctx.arc(unit.x, unit.y, 13, 0, Math.PI * 2); ctx.strokeStyle = `rgba(0,255,0,${0.15 + 0.25 * pulse})`; ctx.lineWidth = 2; ctx.stroke(); } 
      else if (unit.formationBuff.type === "damage") { ctx.beginPath(); ctx.arc(unit.x, unit.y, 14, 0, Math.PI * 2); ctx.strokeStyle = `rgba(255,0,0,${0.2 + 0.3 * pulse})`; ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.restore();
    }
  });

  gameState.buildings.forEach(building => { if (["barracks", "barracks2", "barracks3"].includes(building.type)) updateProductionIndicator(building); });

  gameState.bullets.forEach(bullet => {
    const beamLength = 10;
    const endX = bullet.x - Math.cos(bullet.angle) * beamLength, endY = bullet.y - Math.sin(bullet.angle) * beamLength;
    if (!isFinite(bullet.x) || !isFinite(bullet.y) || !isFinite(endX) || !isFinite(endY)) return;
    const bulletColor = bullet.color ? bullet.color : "255,255,0";
    const gradient = ctx.createLinearGradient(bullet.x, bullet.y, endX, endY);
    gradient.addColorStop(0, "rgba(" + bulletColor + ",1)"); gradient.addColorStop(1, "rgba(" + bulletColor + ",0)");
    ctx.strokeStyle = gradient; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bullet.x, bullet.y); ctx.lineTo(endX, endY); ctx.stroke();
  });

  const currentTime = performance.now();
  gameState.units.forEach(unit => {
    if (unit.type === "elite" && unit.laserBeam && (currentTime - unit.laserBeam.timestamp < 100)) {
      ctx.save(); ctx.strokeStyle = "rgba(255,0,0,0.6)"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(unit.laserBeam.startX, unit.laserBeam.startY); ctx.lineTo(unit.laserBeam.endX, unit.laserBeam.endY); ctx.stroke();
      ctx.restore();
    }
  });

  gameState.particles.forEach(p => {
    ctx.fillStyle = p.color; ctx.globalAlpha = p.life / p.maxLife;
    ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  });

  gameState.resourceTokens.forEach(token => renderWorkerResourceToken(ctx, token));
  renderShockZones();
  renderBombZones();
  ctx.restore();

  for (const laser of gameState.lasers || []) {
    if (!laser.visualFlash) continue;
    const now = performance.now(), elapsed = now - laser.visualFlash.createdAt;
    if (elapsed > laser.visualFlash.duration) continue;
    const alpha = 1 - elapsed / laser.visualFlash.duration, radius = laser.visualFlash.radius;
    const screen = worldToScreen(laser.visualFlash.x, laser.visualFlash.y);
    ctx.beginPath(); ctx.arc(screen.x, screen.y, radius * camera.scale, 0, 2 * Math.PI);
    ctx.fillStyle = `rgba(255, 0, 255, ${alpha})`; ctx.fill();
  }
  // ============================================================
  // ОТРИСОВКА ЛАЗЕРОВ
  // ============================================================
  const nowLaser = performance.now();
  for (const laser of gameState.lasers || []) {
    // 🔥 СТРОГАЯ ПРОВЕРКА: рисуем ТОЛЬКО если активен, и стрелок, и цель ЖИВЫ и в игре
    const isShooterAlive = laser.shooter && laser.shooter.health > 0 && 
      (gameState.units.includes(laser.shooter) || gameState.buildings.includes(laser.shooter));
    const isTargetAlive = laser.target && laser.target.health > 0 && 
      (gameState.units.includes(laser.target) || gameState.buildings.includes(laser.target));

    if (!laser.active || !isShooterAlive || !isTargetAlive) continue;

    const elapsed = nowLaser - laser.startTime;
    const fade = 1 - (elapsed % 1000) / 1000;

    const from = worldToScreen(laser.shooter.x, laser.shooter.y);
    const to = worldToScreen(laser.target.x, laser.target.y);

    ctx.save();
    
    // Внешнее фиолетовое свечение
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = `rgba(255, 0, 255, ${0.5 + 0.5 * fade})`;
    ctx.lineWidth = 4 * camera.scale;
    ctx.shadowColor = "rgba(255, 0, 255, 0.8)";
    ctx.shadowBlur = 15 * camera.scale;
    ctx.stroke();

    // Белый горячий центр луча
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * fade})`;
    ctx.lineWidth = 1.5 * camera.scale;
    ctx.shadowBlur = 0;
    ctx.stroke();

    ctx.restore();
  }
  renderFogOfWar();
  checkVictoryConditions();
  updateBaseNavButton(); updateBase2NavButton(); updateBase3NavButton();
  updateSaleIndicator();
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const worldMultiplier = isMobile ? 4.5 : 3;
  worldWidth = canvas.width * worldMultiplier;
  worldHeight = canvas.height * worldMultiplier;
  starField.init();
  if (typeof initFogOfWar === "function") initFogOfWar();
  if (typeof playerBase !== 'undefined' && playerBase) {
    camera.offsetX = canvas.width / 2 - playerBase.x * camera.scale;
    camera.offsetY = canvas.height / 2 - playerBase.y * camera.scale;
  } else {
    camera.offsetX = canvas.width / 2 - (worldWidth / 2) * camera.scale;
    camera.offsetY = canvas.height / 2 - (worldHeight / 2) * camera.scale;
  }
  const margin = 0.2 * worldWidth;
  if (typeof Quadtree !== 'undefined') {
    quadtree = new Quadtree({ x: -margin, y: -margin, width: worldWidth + 2 * margin, height: worldHeight + 2 * margin });
  }
}

function renderPersistentFog() {
  ctx.save();
  const cellScreenSize = FOG_CELL_SIZE * camera.scale;
  const invScale = 1 / camera.scale;
  const viewLeft = -camera.offsetX * invScale, viewTop = -camera.offsetY * invScale;
  const viewRight = viewLeft + canvas.width * invScale, viewBottom = viewTop + canvas.height * invScale;
  const startCol = Math.max(0, Math.floor(viewLeft / FOG_CELL_SIZE));
  const endCol = Math.min(persistentFogMap[0].length - 1, Math.floor(viewRight / FOG_CELL_SIZE));
  const startRow = Math.max(0, Math.floor(viewTop / FOG_CELL_SIZE));
  const endRow = Math.min(persistentFogMap.length - 1, Math.floor(viewBottom / FOG_CELL_SIZE));
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      const worldX = c * FOG_CELL_SIZE, worldY = r * FOG_CELL_SIZE;
      const screenPos = worldToScreen(worldX, worldY);
      if (persistentFogMap[r][c] === 0) {
        ctx.fillStyle = "rgba(0,0,0, 0.95)";
        ctx.fillRect(screenPos.x, screenPos.y, cellScreenSize, cellScreenSize);
      } else if (fogMap[r][c] < 1) {
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(screenPos.x, screenPos.y, cellScreenSize, cellScreenSize);
      }
    }
  }
  ctx.restore();
}

function renderFogOfWar() { 
	return;
	renderPersistentFog(); }
	  
function renderDynamicFog() {}

function updateResourceUI() {
  document.getElementById("playerGold").innerText = Math.round(gameState.playerResources.gold);
  document.getElementById("playerSilicon").innerText = Math.round(gameState.playerResources.silicon);
  document.getElementById("playerPlasma").innerText = Math.round(gameState.playerResources.plasma);
  document.getElementById("aiGold").innerText = gameState.aiResources.gold;
  document.getElementById("aiSilicon").innerText = gameState.aiResources.silicon;
  document.getElementById("aiPlasma").innerText = gameState.aiResources.plasma;
}

function updateBaseNavButton() {
  const btnId = "baseNavButton", existingBtn = document.getElementById(btnId);
  const base = gameState.buildings.find(b => b.type === "base" && b.owner === playerId);
  if (!base) { if (existingBtn) existingBtn.remove(); return; }
  if (!isBaseVisible(base)) {
    if (!existingBtn) {
      const btn = document.createElement("button");
      btn.id = btnId; btn.innerText = "◀";
      Object.assign(btn.style, { position: "fixed", bottom: "2vh", left: "7vw", opacity: "0.7", zIndex: "1000" });
      btn.addEventListener("click", () => { camera.offsetX = canvas.width / 2 - base.x * camera.scale; camera.offsetY = canvas.height / 2 - base.y * camera.scale; });
      document.body.appendChild(btn);
    }
  } else { if (existingBtn) existingBtn.remove(); }
}

function updateBase2NavButton() {
  const btnId = "base2NavButton", existingBtn = document.getElementById(btnId);
  const playerBase2 = gameState.buildings.find(b => b.owner === playerId && b.type === "base2");
  if (!playerBase2) { if (existingBtn) existingBtn.remove(); return; }
  if (!isBaseVisible(playerBase2)) {
    if (!existingBtn) {
      const btn = document.createElement("button");
      btn.id = btnId; btn.innerText = "<<";
      Object.assign(btn.style, { position: "fixed", bottom: "2vh", left: "13vw", opacity: "0.7", zIndex: "1000" });
      btn.addEventListener("click", () => { camera.offsetX = canvas.width / 2 - playerBase2.x * camera.scale; camera.offsetY = canvas.height / 2 - playerBase2.y * camera.scale; });
      document.body.appendChild(btn);
    }
  } else { if (existingBtn) existingBtn.remove(); }
}

function updateBase3NavButton() {
  const btnId = "base3NavButton", existingBtn = document.getElementById(btnId);
  const playerBase3 = gameState.buildings.find(b => b.owner === playerId && b.type === "base3");
  if (!playerBase3) { if (existingBtn) existingBtn.remove(); return; }
  if (!isBaseVisible(playerBase3)) {
    if (!existingBtn) {
      const btn = document.createElement("button");
      btn.id = btnId; btn.innerText = "<<<";
      Object.assign(btn.style, { position: "fixed", bottom: "2vh", left: "20vw", opacity: "0.7", zIndex: "1000" });
      btn.addEventListener("click", () => { camera.offsetX = canvas.width / 2 - playerBase3.x * camera.scale; camera.offsetY = canvas.height / 2 - playerBase3.y * camera.scale; });
      document.body.appendChild(btn);
    }
  } else { if (existingBtn) existingBtn.remove(); }
}

function updateProductionIndicator(building) {
  if (!gameState.buildings.includes(building) || building.health <= 0) {
    const existing = document.getElementById("productionIndicator_" + building.id);
    if (existing) existing.remove();
    return;
  }
  if (!building.productionQueue || building.productionQueue.length === 0) {
    const existingIndicator = document.getElementById("productionIndicator_" + building.id);
    if (existingIndicator) existingIndicator.remove();
    return;
  }
  let container = document.getElementById("productionIndicator_" + building.id);
  if (!container) {
    container = document.createElement("div");
    container.id = "productionIndicator_" + building.id;
    container.className = "production-indicator";
    (document.getElementById("gameContainer") || document.body).appendChild(container);
  }
  const screenPos = worldToScreen(building.x, building.y);
  container.style.left = (screenPos.x - (building.width * camera.scale) / 2) + "px";
  container.style.top = (screenPos.y + (building.height * camera.scale) - 10) + "px";
  container.style.display = isInFogOfWar(building.x, building.y) ? "none" : "block";
  container.innerHTML = "";
  const now = performance.now();
  building.productionQueue.forEach(order => {
    const section = document.createElement("div");
    section.className = "production-section";
    section.style.width = (5 * camera.scale) + "px";
    section.style.height = (2 * camera.scale) + "px";
    const fill = document.createElement("div");
    fill.className = "production-fill";
    const elapsed = now - order.timeStart;
    fill.style.width = (Math.min(elapsed / order.productionTime, 1) * 100) + "%";
    section.appendChild(fill);
    container.appendChild(section);
  });
}

function isTargetAlive(target) {
  if (target instanceof Unit) return gameState.units.includes(target);
  if (target instanceof Building) return gameState.buildings.includes(target);
  return false;
}