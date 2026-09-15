import * as THREE from '../vendor/three.module.js';
import { TrafficService } from './EnvironmentIngestion.js';

export function formatNumber(n) {
  return String(Math.round(n * 10) / 10);
}

const $ = (id) => document.getElementById(id);

export function setupUI(ctx) {
  const sim = ctx.sim;
  const weather = ctx.weather;
  const traffic = ctx.traffic;
  const cityScene = ctx.cityScene;
  const city = ctx.city;
  const camera = ctx.camera;
  const controls = ctx.controls;
  const scene = ctx.scene;
  const renderer = ctx.renderer;
  const vehicleMeshes = ctx.vehicleMeshes;

  const state = {
    demand: 1.0,
    lodOn: true,
    trafficColors: true,
    selection: null,
    colorTimer: 0,
  };

  const params = new URLSearchParams(location.search);

  const bind = (id, outId, fmt, handler, paramName) => {
    const el = $(id), out = $(outId);
    if (paramName && params.has(paramName)) {
      const v = parseFloat(params.get(paramName));
      if (Number.isFinite(v)) el.value = v;
    }
    const apply = () => {
      const v = parseFloat(el.value);
      if (out) out.textContent = fmt(v);
      handler(v);
    };
    el.addEventListener('input', apply);
    apply();
  };

  bind('vehCount', 'outVeh', v => v.toString(), v => ctx.onVehicleCount(v), 'vehicles');
  bind('demand', 'outDemand', v => v.toFixed(1) + 'x', v => { state.demand = v; }, 'demand');
  bind('hour', 'outHour', v => {
    const h = Math.floor(v), m = Math.round((v % 1) * 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }, v => ctx.onHourChange(v), 'hour');

  bind('rain', 'outRain', v => v + ' mm/h', v => {
    weather.setManual({ rainMmH: v, clouds: Math.min(100, 20 + v * 9), visibility: Math.max(600, 10000 - v * 850) });
    $('rainNote').innerHTML = 'Particle Emission = Intensity x 80 -> <b>' + Math.round(v * 80) + '</b>';
    $('weatherSrc').textContent = 'Data Source: ' + weather.state.source;
  }, 'rain');

  bind('wind', 'outWind', v => v + ' m/s', v => weather.setManual({ windSpeed: v }), 'wind');

  $('lodOn').addEventListener('change', e => { state.lodOn = e.target.checked; });
  $('showPaths').addEventListener('change', e => ctx.onPathsToggle(e.target.checked));
  $('trafficColors').addEventListener('change', e => {
    state.trafficColors = e.target.checked;
    cityScene.applyTrafficColors(traffic, state.trafficColors);
  });

  $('fetchWeather').addEventListener('click', async () => {
    const key = $('owmKey').value.trim();
    if (!key) { $('weatherSrc').textContent = 'Data Source: API Key Required'; return; }
    weather.apiKey = key;
    $('weatherSrc').textContent = 'Fetching...';
    const ok = await weather.fetchLive();
    if (ok) {
        $('weatherSrc').textContent = 'Data Source: ' + weather.state.source + ' - ' + weather.state.description + ', ' + weather.state.tempC.toFixed(0) + ' Deg';
        $('rain').value = weather.state.rainMmH;
        $('outRain').textContent = weather.state.rainMmH + ' mm/h';
        $('rainNote').innerHTML = 'Particle Emission = Intensity x 80 -> <b>' + Math.round(weather.state.rainMmH * 80) + '</b>';
    } else {
        $('weatherSrc').textContent = 'Data Source: Fetch Failed, using simulation';
    }
  });

  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 2;
  const pointer = new THREE.Vector2();
  let highlight = null;

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const vehTargets = [...vehicleMeshes.values()].map(v => v.mesh);
    const hitsV = raycaster.intersectObjects(vehTargets, false);
    if (hitsV.length) {
      const h = hitsV[0];
      const entry = [...vehicleMeshes.values()].find(v => v.mesh === h.object);
      const agent = (entry && entry.agents) ? entry.agents[h.instanceId] : null;
      if (agent) { select({ kind: 'vehicle', agent }); return; }
    }

    const hitsR = raycaster.intersectObjects(cityScene.groups.roads.children, false);
    if (hitsR.length) { select({ kind: 'road', road: hitsR[0].object.userData.road, mesh: hitsR[0].object }); return; }

    const hitsB = raycaster.intersectObject(cityScene.buildingMesh, false);
    if (hitsB.length) {
      const b = cityScene.buildingAtVertex(hitsB[0].face.a);
      if (b) { select({ kind: 'building', building: b, point: hitsB[0].point }); return; }
    }

    select(null);
  });

  function clearHighlight() {
    if (highlight && highlight.mesh && highlight.originalColor !== undefined && highlight.originalColor !== null) {
      highlight.mesh.material.color.setHex(highlight.originalColor);
    }
    if (highlight && highlight.marker) { scene.remove(highlight.marker); highlight.marker.geometry.dispose(); }
    highlight = null;
  }

  function select(sel) {
    clearHighlight();
    state.selection = sel;
    if (!sel) { renderInspector(); return; }

    if (sel.kind === 'road') {
      highlight = { mesh: sel.mesh, originalColor: sel.mesh.material.color.getHex() };
      sel.mesh.material.color.setHex(0x4da3ff);
    } else if (sel.kind === 'building') {
      const geo = new THREE.RingGeometry(6, 8, 28);
      geo.rotateX(-Math.PI / 2);
      const marker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x4da3ff }));
      marker.position.set(sel.point.x, 0.6, sel.point.z);
      scene.add(marker);
      highlight = { marker };
    }
    renderInspector();
  }

  $('doSearch').addEventListener('click', doSearch);
  $('typeSearch').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  function doSearch() {
    const q = $('typeSearch').value.trim().toLowerCase();
    if (!q) return;
    const matches = sim.agents.filter(a => a.type.typeId.toLowerCase().indexOf(q) !== -1);
    if (matches.length) {
      const a = matches[0];
      focusOn(a.veh.x, a.veh.z, 45);
      select({ kind: 'vehicle', agent: a, groupSize: matches.length });
      return;
    }
    const road = city.roads.find(r => r.name.toLowerCase().indexOf(q) !== -1);
    if (road) {
      const mid = road.line[Math.floor(road.line.length / 2)];
      focusOn(mid[0], mid[1], 120);
      select({ kind: 'road', road, mesh: cityScene.roadMeshes.get(road.id) });
      return;
    }
    $('inspectBody').innerHTML = '<p class="hint">No match found for "' + q + '".<br>Example: BusID-7, TaxiID-3, or Cheapside</p>';
  }

  function focusOn(x, z, dist) {
    controls.target.set(x, 0, z);
    camera.position.set(x + dist * 0.7, dist * 0.8, z + dist * 0.7);
  }

  const kv = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>';

  function renderInspector() {
    const el = $('inspectBody');
    const sel = state.selection;
    if (!sel) {
      el.innerHTML = '<p class="hint">Click on a road, building, or vehicle to inspect live data.</p>';
      return;
    }

    if (sel.kind === 'road') {
      const r = sel.road;
      const t = traffic.get(r.id);
      const tLevel = (t && t.level) ? t.level : 1;
      const lv = TrafficService.LEVELS[tLevel - 1];
      const speedStr = (t && t.speed) !== undefined ? t.speed : '--';
      const occStr = (t && t.occupancy) !== undefined ? t.occupancy : '--';
      
      el.innerHTML = 
        '<p class="title">' + r.name + '</p>' +
        '<div class="kv"><span>Status</span>' +
          '<b><span class="badge" style="background:#' + lv.color.toString(16).padStart(6, '0') + '">' + lv.name + '</span></b></div>' +
        kv('Road ID', r.id) +
        kv('Type', r.type) +
        kv('Lanes', r.lanes) +
        kv('Width', r.width + ' m') +
        kv('Length', r.len + ' m') +
        kv('Average Speed', speedStr + ' km/h') +
        kv('Occupancy', occStr + '%') +
        kv('Oneway', r.oneway ? 'Yes' : 'No') +
        '<p class="hint" style="margin-top:8px">Data updated via Layer 2 Environment Ingestion module.</p>';
    }

    else if (sel.kind === 'building') {
      const b = sel.building;
      el.innerHTML = 
        '<p class="title">' + (b.name || 'Unnamed Structure') + '</p>' +
        kv('OSM ID', b.id) +
        kv('Height', b.h + ' m') +
        kv('Est. Floors', Math.max(1, Math.round(b.h / 3.2))) +
        kv('Material Code', b.mat) +
        kv('Base Vertices', b.poly.length) +
        '<p class="hint" style="margin-top:8px">BIM Material Codes injected via geospatial attribute association.</p>';
    }

    else if (sel.kind === 'vehicle') {
      const a = sel.agent;
      const v = a.veh;
      el.innerHTML = 
        '<p class="title">' + a.type.name + ' · ' + a.type.typeId + '</p>' +
        (sel.groupSize ? kv('Instances Active', sel.groupSize) : '') +
        kv('Longitudinal Speed (u)', (v.u * 3.6).toFixed(1) + ' km/h') +
        kv('Lateral Speed (v)', v.v.toFixed(3) + ' m/s') +
        kv('Yaw Rate (r)', (v.r * 180 / Math.PI).toFixed(1) + ' °/s') +
        kv('Steering Angle (δf)', (v.delta * 180 / Math.PI).toFixed(1) + '°') +
        kv('Assist Torque (Mz)', v.Mz.toFixed(0) + ' N·m') +
        kv('Lateral Accel', v.ay.toFixed(2) + ' m/s²') +
        kv('Front Slip (αf)', (v.alphaF * 180 / Math.PI).toFixed(2) + '°') +
        kv('Rear Slip (αr)', (v.alphaR * 180 / Math.PI).toFixed(2) + '°') +
        kv('Cross-Track Error', a.crossTrack.toFixed(3) + ' m') +
        kv('Non-Linear Correction', v.nonlinearOn ? 'Active (δf > 0.2)' : 'Idle') +
        kv('LOD Priority', a.lod.name) +
        kv('Battery State', v.battery.toFixed(1) + '%') +
        kv('Odometer', (v.odometer / 1000).toFixed(2) + ' km');
    }
  }

  let inspTick = 0;
  function tickInspector() {
    if (state.selection && state.selection.kind !== 'vehicle') return;
    if (++inspTick % 5 !== 0) return;
    renderInspector();
  }

  function tickTrafficColors(dt) {
    state.colorTimer += dt;
    if (state.colorTimer < 0.5) return;
    state.colorTimer = 0;
    cityScene.applyTrafficColors(traffic, state.trafficColors);
  }

  const totalRoadKm = city.roads ? city.roads.reduce((s, r) => s + r.len, 0) / 1000 : 0;

  function updateDashboard(data) {
    const fps = data.fps;
    const physicsMs = data.physicsMs;
    const s = sim.summary();
    const t = traffic.summary();
    $('dFps').textContent   = fps.toFixed(0);
    $('dVeh').textContent   = s.count;
    $('dPhys').textContent  = physicsMs.toFixed(2) + ' ms';
    $('dSpeed').textContent = s.avgSpeedKmh + ' km/h';
    $('dErr').textContent   = s.avgCrossTrack.toFixed(2) + ' m';
    $('dServed').textContent= s.servicedVehicles;
    $('dDist').textContent  = s.totalDistanceKm.toFixed(1) + ' km';
    $('dJam').textContent   = t.congestionRate + '%';
    $('dRoad').textContent  = totalRoadKm.toFixed(1) + ' km';
    $('dLod').textContent   = s.lod.near + '/' + s.lod.mid + '/' + s.lod.far;

    $('dFps').style.color = fps >= 60 ? 'var(--good)' : fps >= 30 ? 'var(--warn)' : 'var(--bad)';
  }

  return { state, updateDashboard, tickInspector, tickTrafficColors, renderInspector, focusOn, select };
}