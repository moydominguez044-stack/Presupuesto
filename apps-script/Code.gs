/**
 * PRESUPUESTO EN PAREJA v2 — Google Apps Script
 * ------------------------------------------------------------
 * Script vinculado a una Google Sheet (Extensiones > Apps Script).
 * Crea y mantiene estas hojas:
 *   Config        clave | valor
 *   Categorias    id | tipo | grupo | nombre | persona | orden | activo
 *   Presupuesto   anio | mes | categoriaId | monto        (categoriaId también puede ser el id de una meta)
 *   Movimientos   id | fecha | tipo | categoriaId | persona | monto | nota | creadoEn | ambito | reparto
 *                 | registradoPor | revisar | recurrenteId | destino
 *   Recurrentes   id | nombre | categoriaId | monto | frecuencia | dia | mes | persona | activo
 *   Metas         id | nombre | objetivo | fechaMeta | activo | creadoEn
 *   AportesMetas  id | metaId | fecha | persona | monto | nota
 *
 * persona: 1 y 2 = cada miembro de la pareja; 0 = fondo común (solo gastos)
 * tipo de movimiento: ingreso | gasto | liquidacion (pago entre ustedes: persona -> destino)
 * ambito (gastos): hogar | personal
 * reparto (gastos del hogar pagados por 1 o 2): % que le corresponde a la persona 1
 */

const HOJAS = {
  CONFIG:      { nombre: 'Config',       cols: ['clave', 'valor'], texto: ['clave'] },
  CATEGORIAS:  { nombre: 'Categorias',   cols: ['id', 'tipo', 'grupo', 'nombre', 'persona', 'orden', 'activo'], texto: ['id'] },
  PRESUPUESTO: { nombre: 'Presupuesto',  cols: ['anio', 'mes', 'categoriaId', 'monto'], texto: ['categoriaId'] },
  MOVIMIENTOS: { nombre: 'Movimientos',  cols: ['id', 'fecha', 'tipo', 'categoriaId', 'persona', 'monto', 'nota', 'creadoEn', 'ambito', 'reparto', 'registradoPor', 'revisar', 'recurrenteId', 'destino'], texto: ['id', 'fecha', 'categoriaId', 'recurrenteId'] },
  RECURRENTES: { nombre: 'Recurrentes',  cols: ['id', 'nombre', 'categoriaId', 'monto', 'frecuencia', 'dia', 'mes', 'persona', 'activo'], texto: ['id', 'categoriaId'] },
  METAS:       { nombre: 'Metas',        cols: ['id', 'nombre', 'objetivo', 'fechaMeta', 'activo', 'creadoEn'], texto: ['id', 'fechaMeta'] },
  APORTES:     { nombre: 'AportesMetas', cols: ['id', 'metaId', 'fecha', 'persona', 'monto', 'nota'], texto: ['id', 'metaId', 'fecha'] }
};

const SAL_PIN = 'presupuesto-pareja:';
let _cacheHojas = {};
let _cacheConfig = null;

/* ========================= WEB APP ========================= */

/**
 * Sin parámetros: si el proyecto tiene el archivo Index, sirve la app dentro de Apps Script.
 * Si no lo tiene (versión GitHub), responde que la API está activa.
 */
function doGet(e) {
  asegurarEstructura_();
  try {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Presupuesto en Pareja')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return json_({ ok: true, api: 'Presupuesto en Pareja', mensaje: 'API activa. Pegue esta URL en la app: Más > Sincronizar con su pareja.' });
  }
}

/* ========================= API JSON (app de GitHub Pages) =========================
 * POST con cuerpo de texto JSON: { pin: "1234", ops: [ { fn: "guardarMovimiento", args: [ {...} ] }, ... ] }
 * Aplica las operaciones en orden (las que la app guardó sin conexión) y devuelve todos los datos.
 * Respuesta: { ok: true, data: {...}, errores: [] }  o  { ok: false, error: "..." }
 */
let _enLote = false;

function doPost(e) {
  try {
    const cuerpo = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    let pin = String(cuerpo.pin || '');
    verificar_(pin);
    const API = {
      guardarMovimiento: guardarMovimiento, eliminarMovimiento: eliminarMovimiento, marcarRevisado: marcarRevisado,
      guardarPresupuesto: guardarPresupuesto, guardarConfig: guardarConfig, guardarCategoria: guardarCategoria,
      guardarRecurrente: guardarRecurrente, eliminarRecurrente: eliminarRecurrente, guardarMeta: guardarMeta,
      guardarAporte: guardarAporte, eliminarAporte: eliminarAporte, cambiarPin: cambiarPin,
      activarRecordatorios: activarRecordatorios, desactivarRecordatorios: desactivarRecordatorios,
      enviarPruebaRecordatorio: enviarPruebaRecordatorio, importarTodo: importarTodo
    };
    const errores = [];
    _enLote = true;
    (cuerpo.ops || []).slice(0, 500).forEach(function (op) {
      const fn = API[op && op.fn];
      if (!fn) { errores.push('Operación desconocida: ' + (op && op.fn)); return; }
      try {
        fn.apply(null, [pin].concat(op.args || []));
        if (op.fn === 'cambiarPin') pin = String((op.args || [])[0] || '');
      } catch (err) {
        errores.push(op.fn + ': ' + err.message);
      }
    });
    _enLote = false;
    _cacheConfig = null;
    return json_({ ok: true, data: datos_(), errores: errores });
  } catch (err) {
    _enLote = false;
    return json_({ ok: false, error: err.message });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** En lote no recalcula todos los datos después de cada operación. */
function respuesta_() { return _enLote ? null : datos_(); }

/**
 * Reemplaza TODOS los datos de la hoja con los que manda un celular
 * (se usa al conectar un celular que ya tenía datos guardados sin conexión). Conserva el PIN.
 */
function importarTodo(pin, d) {
  verificar_(pin);
  return conLock_(function () {
    if (!d || !Array.isArray(d.categorias) || !d.categorias.length) throw new Error('Datos inválidos para importar.');
    const lista = function (x) { return Array.isArray(x) ? x : []; };
    const c = config_(), nc = d.config || {};
    setConfig_({
      nombre1: texto_(nc.nombre1, c.nombre1), nombre2: texto_(nc.nombre2, c.nombre2),
      pct1: numero_(nc.pct1, c.pct1), pct2: numero_(nc.pct2, c.pct2), moneda: texto_(nc.moneda, c.moneda),
      reparto: texto_(nc.reparto, c.reparto), repartoPct1: numero_(nc.repartoPct1, c.repartoPct1),
      email1: c.email1, email2: c.email2, diasAviso: c.diasAviso, pinHash: c.pinHash
    });
    escribirTodo_(HOJAS.CATEGORIAS, lista(d.categorias));
    escribirTodo_(HOJAS.PRESUPUESTO, lista(d.presupuesto));
    escribirTodo_(HOJAS.MOVIMIENTOS, lista(d.movimientos).map(function (m) {
      return Object.assign({}, m, { creadoEn: m.creadoEn || new Date(), registradoPor: m.registradoPor || '', destino: m.destino || '' });
    }));
    escribirTodo_(HOJAS.RECURRENTES, lista(d.recurrentes).map(function (r) { return Object.assign({}, r, { mes: r.frecuencia === 'anual' ? r.mes : '' }); }));
    escribirTodo_(HOJAS.METAS, lista(d.metas).map(function (g) { return Object.assign({ creadoEn: new Date() }, g); }));
    escribirTodo_(HOJAS.APORTES, lista(d.aportes));
    return respuesta_();
  });
}

/** Ejecútela una vez desde el editor para crear las hojas y autorizar los permisos. */
function instalar() {
  asegurarEstructura_();
  const ss = ss_();
  try { ss.toast('Estructura lista. Ahora implemente como aplicación web.', 'Presupuesto en Pareja'); } catch (e) {}
  Logger.log('Listo. Hoja de datos: ' + ss.getUrl());
}

/* ========================= API (google.script.run) =========================
 * Todas reciben el PIN como primer argumento (vacío si no hay PIN configurado).
 */

function getData(pin) {
  verificar_(pin);
  return datos_();
}

function guardarMovimiento(pin, m) {
  verificar_(pin);
  return conLock_(function () {
    if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(m.fecha))) throw new Error('Fecha inválida.');
    const monto = Math.round(Number(m.monto) * 100) / 100;
    if (!(monto > 0)) throw new Error('El monto debe ser mayor que cero.');
    const filas = leer_(HOJAS.MOVIMIENTOS);
    const previo = m.id ? filas.filter(function (f) { return String(f.id) === String(m.id); })[0] : null;

    const fila = {
      id: previo ? String(previo.id) : (m.id ? String(m.id).slice(0, 40) : nuevoId_('m')),
      fecha: String(m.fecha),
      monto: monto,
      nota: String(m.nota || '').slice(0, 200),
      creadoEn: previo ? previo.creadoEn : new Date(),
      registradoPor: previo ? previo.registradoPor : ([1, 2].indexOf(Number(m.registradoPor)) >= 0 ? Number(m.registradoPor) : ''),
      revisar: m.revisar === true,
      recurrenteId: String(m.recurrenteId || ''),
      categoriaId: '', persona: 0, ambito: '', reparto: '', destino: '', tipo: ''
    };

    if (m.tipo === 'liquidacion') {
      const de = Number(m.persona) === 2 ? 2 : 1;
      fila.tipo = 'liquidacion';
      fila.persona = de;
      fila.destino = de === 1 ? 2 : 1;
      fila.recurrenteId = '';
    } else {
      const cat = leer_(HOJAS.CATEGORIAS).filter(function (c) { return String(c.id) === String(m.categoriaId); })[0];
      if (!cat) throw new Error('Categoría no encontrada.');
      fila.categoriaId = String(cat.id);
      if (String(cat.tipo) === 'ingreso') {
        fila.tipo = 'ingreso';
        fila.persona = Number(cat.persona) === 2 ? 2 : 1;
        fila.ambito = 'hogar';
        fila.recurrenteId = '';
      } else {
        fila.tipo = 'gasto';
        fila.persona = [0, 1, 2].indexOf(Number(m.persona)) >= 0 ? Number(m.persona) : 0;
        fila.ambito = (m.ambito === 'personal' && fila.persona !== 0) ? 'personal' : 'hogar';
        if (fila.ambito === 'hogar' && fila.persona !== 0 && m.reparto !== '' && m.reparto !== null && m.reparto !== undefined) {
          const r = Number(m.reparto);
          if (isFinite(r)) fila.reparto = Math.min(100, Math.max(0, Math.round(r * 10) / 10));
        }
      }
    }

    if (previo) {
      for (let i = 0; i < filas.length; i++) if (String(filas[i].id) === fila.id) filas[i] = fila;
    } else {
      filas.push(fila);
    }
    escribirTodo_(HOJAS.MOVIMIENTOS, filas);
    return respuesta_();
  });
}

function eliminarMovimiento(pin, id) {
  verificar_(pin);
  return conLock_(function () {
    escribirTodo_(HOJAS.MOVIMIENTOS, leer_(HOJAS.MOVIMIENTOS).filter(function (f) { return String(f.id) !== String(id); }));
    return respuesta_();
  });
}

function marcarRevisado(pin, id) {
  verificar_(pin);
  return conLock_(function () {
    const filas = leer_(HOJAS.MOVIMIENTOS);
    filas.forEach(function (f) { if (String(f.id) === String(id)) f.revisar = false; });
    escribirTodo_(HOJAS.MOVIMIENTOS, filas);
    return respuesta_();
  });
}

/**
 * Reemplaza el presupuesto de los meses indicados con los mismos montos.
 * items: [{categoriaId, monto}] — categoriaId puede ser una categoría o una meta.
 */
function guardarPresupuesto(pin, anio, meses, items) {
  verificar_(pin);
  return conLock_(function () {
    anio = Number(anio);
    meses = (meses || []).map(Number).filter(function (x) { return x >= 1 && x <= 12; });
    if (!anio || !meses.length) throw new Error('Mes inválido.');
    const filas = leer_(HOJAS.PRESUPUESTO).filter(function (p) {
      return !(Number(p.anio) === anio && meses.indexOf(Number(p.mes)) >= 0);
    });
    meses.forEach(function (mes) {
      (items || []).forEach(function (it) {
        const monto = Math.round((Number(it.monto) || 0) * 100) / 100;
        if (monto > 0) filas.push({ anio: anio, mes: mes, categoriaId: String(it.categoriaId), monto: monto });
      });
    });
    filas.sort(function (a, b) { return (a.anio - b.anio) || (a.mes - b.mes); });
    escribirTodo_(HOJAS.PRESUPUESTO, filas);
    return respuesta_();
  });
}

function guardarConfig(pin, c) {
  verificar_(pin);
  return conLock_(function () {
    const pct = function (v, d) { const n = Number(v); return isFinite(n) && v !== '' ? Math.min(100, Math.max(0, n)) : d; };
    const correo = function (v) { v = String(v || '').trim(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : ''; };
    const actual = config_();
    setConfig_({
      nombre1: String(c.nombre1 || 'Persona 1').slice(0, 40),
      nombre2: String(c.nombre2 || 'Persona 2').slice(0, 40),
      pct1: pct(c.pct1, 100),
      pct2: pct(c.pct2, 100),
      moneda: String(c.moneda || 'C$').slice(0, 5),
      reparto: ['proporcional', 'mitad', 'personalizado'].indexOf(c.reparto) >= 0 ? c.reparto : 'proporcional',
      repartoPct1: pct(c.repartoPct1, 50),
      email1: correo(c.email1),
      email2: correo(c.email2),
      diasAviso: Math.min(15, Math.max(0, Math.round(Number(c.diasAviso)) || 3)),
      pinHash: actual.pinHash || ''
    });
    return respuesta_();
  });
}

function guardarCategoria(pin, c) {
  verificar_(pin);
  return conLock_(function () {
    const nombre = String(c.nombre || '').trim();
    if (!nombre) throw new Error('Escriba un nombre para la categoría.');
    const filas = leer_(HOJAS.CATEGORIAS);
    const tipo = c.tipo === 'ingreso' ? 'ingreso' : 'gasto';
    const fila = {
      id: c.id ? String(c.id) : nuevoId_('c'),
      tipo: tipo,
      grupo: tipo === 'ingreso' ? 'Ingresos' : (String(c.grupo || '').trim() || 'Varios'),
      nombre: nombre.slice(0, 60),
      persona: tipo === 'ingreso' ? (Number(c.persona) === 2 ? 2 : 1) : 0,
      orden: 0,
      activo: c.activo !== false
    };
    upsert_(filas, fila, function (prev) { fila.orden = prev.orden; }, function () {
      fila.orden = filas.reduce(function (mx, f) { return Math.max(mx, Number(f.orden) || 0); }, 0) + 1;
    });
    escribirTodo_(HOJAS.CATEGORIAS, filas);
    return respuesta_();
  });
}

function guardarRecurrente(pin, r) {
  verificar_(pin);
  return conLock_(function () {
    const nombre = String(r.nombre || '').trim();
    if (!nombre) throw new Error('Escriba un nombre para el pago fijo.');
    const monto = Math.round(Number(r.monto) * 100) / 100;
    if (!(monto > 0)) throw new Error('El monto debe ser mayor que cero.');
    if (!leer_(HOJAS.CATEGORIAS).some(function (c) { return String(c.id) === String(r.categoriaId) && String(c.tipo) === 'gasto'; })) {
      throw new Error('Elija una categoría de gasto.');
    }
    const filas = leer_(HOJAS.RECURRENTES);
    const fila = {
      id: r.id ? String(r.id) : nuevoId_('r'),
      nombre: nombre.slice(0, 60),
      categoriaId: String(r.categoriaId),
      monto: monto,
      frecuencia: r.frecuencia === 'anual' ? 'anual' : 'mensual',
      dia: Math.min(31, Math.max(1, Math.round(Number(r.dia)) || 1)),
      mes: r.frecuencia === 'anual' ? Math.min(12, Math.max(1, Math.round(Number(r.mes)) || 1)) : '',
      persona: [0, 1, 2].indexOf(Number(r.persona)) >= 0 ? Number(r.persona) : 0,
      activo: r.activo !== false
    };
    upsert_(filas, fila);
    escribirTodo_(HOJAS.RECURRENTES, filas);
    return respuesta_();
  });
}

function eliminarRecurrente(pin, id) {
  verificar_(pin);
  return conLock_(function () {
    escribirTodo_(HOJAS.RECURRENTES, leer_(HOJAS.RECURRENTES).filter(function (f) { return String(f.id) !== String(id); }));
    return respuesta_();
  });
}

function guardarMeta(pin, m) {
  verificar_(pin);
  return conLock_(function () {
    const nombre = String(m.nombre || '').trim();
    if (!nombre) throw new Error('Escriba un nombre para la meta.');
    const objetivo = Math.round(Number(m.objetivo) * 100) / 100;
    if (!(objetivo > 0)) throw new Error('El objetivo debe ser mayor que cero.');
    const filas = leer_(HOJAS.METAS);
    const fila = {
      id: m.id ? String(m.id) : nuevoId_('g'),
      nombre: nombre.slice(0, 60),
      objetivo: objetivo,
      fechaMeta: /^\d{4}-\d{2}-\d{2}$/.test(String(m.fechaMeta)) ? String(m.fechaMeta) : '',
      activo: m.activo !== false,
      creadoEn: new Date()
    };
    upsert_(filas, fila, function (prev) { fila.creadoEn = prev.creadoEn || fila.creadoEn; });
    escribirTodo_(HOJAS.METAS, filas);
    return respuesta_();
  });
}

function guardarAporte(pin, a) {
  verificar_(pin);
  return conLock_(function () {
    if (!leer_(HOJAS.METAS).some(function (g) { return String(g.id) === String(a.metaId); })) throw new Error('Meta no encontrada.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.fecha))) throw new Error('Fecha inválida.');
    const monto = Math.round(Number(a.monto) * 100) / 100;
    if (!monto) throw new Error('Escriba un monto.');
    const filas = leer_(HOJAS.APORTES);
    const fila = {
      id: a.id ? String(a.id) : nuevoId_('a'),
      metaId: String(a.metaId),
      fecha: String(a.fecha),
      persona: [0, 1, 2].indexOf(Number(a.persona)) >= 0 ? Number(a.persona) : 0,
      monto: monto, // negativo = retiro
      nota: String(a.nota || '').slice(0, 200)
    };
    upsert_(filas, fila);
    escribirTodo_(HOJAS.APORTES, filas);
    return respuesta_();
  });
}

function eliminarAporte(pin, id) {
  verificar_(pin);
  return conLock_(function () {
    escribirTodo_(HOJAS.APORTES, leer_(HOJAS.APORTES).filter(function (f) { return String(f.id) !== String(id); }));
    return respuesta_();
  });
}

/** Cambia, crea o quita el PIN. pinNuevo vacío = quitar PIN. */
function cambiarPin(pinActual, pinNuevo) {
  verificar_(pinActual);
  return conLock_(function () {
    pinNuevo = String(pinNuevo || '').trim();
    if (pinNuevo && !/^\d{4,8}$/.test(pinNuevo)) throw new Error('El PIN debe tener de 4 a 8 números.');
    const c = config_();
    c.pinHash = pinNuevo ? hash_(pinNuevo) : '';
    setConfig_(c);
    return respuesta_();
  });
}

function activarRecordatorios(pin) {
  verificar_(pin);
  const c = config_();
  if (!c.email1 && !c.email2) throw new Error('Guarde al menos un correo en Ajustes antes de activar los recordatorios.');
  quitarTriggers_();
  ScriptApp.newTrigger('revisarRecordatorios').timeBased().everyDays(1).atHour(7).create();
  return respuesta_();
}

function desactivarRecordatorios(pin) {
  verificar_(pin);
  quitarTriggers_();
  return respuesta_();
}

function enviarPruebaRecordatorio(pin) {
  verificar_(pin);
  const enviado = revisarRecordatorios(true);
  if (!enviado) throw new Error('No hay correos configurados.');
  return respuesta_();
}

/* ========================= RECORDATORIOS POR CORREO ========================= */

/**
 * Se ejecuta a diario (activador). Envía un correo solo si hay algo que avisar:
 * pagos fijos por vencer o vencidos, categorías cerca del límite y, el día 1, el cierre del mes anterior.
 */
function revisarRecordatorios(forzar) {
  const d = datos_();
  const c = d.config;
  const destinos = [c.email1, c.email2].filter(function (e) { return e; });
  if (!destinos.length) return false;

  const tz = ss_().getSpreadsheetTimeZone();
  const hoyTxt = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const anio = Number(hoyTxt.slice(0, 4)), mes = Number(hoyTxt.slice(5, 7)), dia = Number(hoyTxt.slice(8, 10));
  const fmt = function (v) { return c.moneda + ' ' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const nom = function (p) { return p === 1 ? c.nombre1 : p === 2 ? c.nombre2 : 'Fondo común'; };
  const claveMes = anio + '-' + ('0' + mes).slice(-2);

  // Pagos fijos
  const ultimoDia = new Date(anio, mes, 0).getDate();
  const proximos = [], vencidos = [];
  d.recurrentes.filter(function (r) { return r.activo && (r.frecuencia === 'mensual' || r.mes === mes); }).forEach(function (r) {
    const pagado = d.movimientos.some(function (m) { return m.recurrenteId === r.id && m.fecha.slice(0, 7) === claveMes; });
    if (pagado) return;
    const vence = Math.min(r.dia, ultimoDia);
    const faltan = vence - dia;
    const linea = '<b>' + esc_(r.nombre) + '</b> — ' + fmt(r.monto) + ' · día ' + vence + ' · paga ' + esc_(nom(r.persona));
    if (faltan < 0) vencidos.push(linea + ' <span style="color:#c9492f">(venció hace ' + (-faltan) + ' día' + (faltan === -1 ? '' : 's') + ')</span>');
    else if (faltan <= c.diasAviso) proximos.push(linea + (faltan === 0 ? ' <b>(vence hoy)</b>' : ' (en ' + faltan + ' día' + (faltan === 1 ? '' : 's') + ')'));
  });

  // Límites de categorías
  const pres = {}, real = {};
  d.presupuesto.forEach(function (p) { if (p.anio === anio && p.mes === mes) pres[p.categoriaId] = (pres[p.categoriaId] || 0) + p.monto; });
  d.movimientos.forEach(function (m) {
    if (m.tipo === 'gasto' && m.ambito !== 'personal' && m.fecha.slice(0, 7) === claveMes) real[m.categoriaId] = (real[m.categoriaId] || 0) + m.monto;
  });
  const limites = [];
  d.categorias.forEach(function (k) {
    if (k.tipo !== 'gasto' || !pres[k.id] || !real[k.id]) return;
    const r = real[k.id] / pres[k.id];
    if (r >= 0.9) limites.push('<b>' + esc_(k.nombre) + '</b>: ' + fmt(real[k.id]) + ' de ' + fmt(pres[k.id]) + ' (' + Math.round(r * 100) + '%)');
  });

  // Cierre del mes anterior (día 1)
  let cierre = '';
  if (dia === 1 || forzar === true) {
    const pa = mes === 1 ? anio - 1 : anio, pm = mes === 1 ? 12 : mes - 1;
    const k = pa + '-' + ('0' + pm).slice(-2);
    let i1 = 0, i2 = 0, g = 0, ah = 0;
    d.movimientos.forEach(function (m) {
      if (m.fecha.slice(0, 7) !== k) return;
      if (m.tipo === 'ingreso') { if (m.persona === 2) i2 += m.monto; else i1 += m.monto; }
      if (m.tipo === 'gasto' && m.ambito !== 'personal') g += m.monto;
    });
    d.aportes.forEach(function (a) { if (a.fecha.slice(0, 7) === k) ah += a.monto; });
    const ing = i1 * c.pct1 / 100 + i2 * c.pct2 / 100, bal = ing - g - ah;
    cierre = '<p>Ingresos aportados: <b>' + fmt(ing) + '</b><br>Gastos del hogar: <b>' + fmt(g) + '</b><br>Ahorro en metas: <b>' + fmt(ah) +
      '</b><br>Balance: <b style="color:' + (bal < 0 ? '#c9492f' : '#23845a') + '">' + fmt(bal) + '</b></p><p>' +
      (bal < 0 ? 'No vivieron dentro de sus posibilidades: toca recortar gastos este mes.' : '¡Bravo! Vivieron dentro de sus posibilidades.') + '</p>';
    cierre = '<h3 style="margin:18px 0 6px">Cierre del mes anterior</h3>' + cierre;
  }

  if (!forzar && !proximos.length && !vencidos.length && !limites.length && !cierre) return false;

  const lista = function (t, xs) { return xs.length ? '<h3 style="margin:18px 0 6px">' + t + '</h3><ul style="padding-left:18px;margin:0">' + xs.map(function (x) { return '<li style="margin:4px 0">' + x + '</li>'; }).join('') + '</ul>' : ''; };
  let cuerpo = lista('Pagos vencidos', vencidos) + lista('Pagos por vencer', proximos) + lista('Categorías cerca del límite', limites) + cierre;
  if (!cuerpo) cuerpo = '<p>Todo al día: no hay pagos pendientes ni categorías cerca del límite.</p>';
  const url = ScriptApp.getService().getUrl();
  const html = '<div style="font-family:Arial,sans-serif;color:#1d2a2e;max-width:520px">' +
    '<h2 style="color:#0f6e6a;margin:0 0 4px">Presupuesto en Pareja</h2><div style="color:#6b7478;font-size:13px">' + hoyTxt + '</div>' +
    cuerpo + (url ? '<p style="margin-top:22px"><a href="' + url + '" style="background:#0f6e6a;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none">Abrir la app</a></p>' : '') + '</div>';
  const asunto = vencidos.length ? 'Tienen ' + vencidos.length + ' pago(s) vencido(s)'
    : proximos.length ? 'Pagos por vencer esta semana'
    : limites.length ? 'Categorías cerca del límite' : 'Resumen de su presupuesto';
  MailApp.sendEmail({ to: destinos.join(','), subject: 'Presupuesto en Pareja: ' + asunto, htmlBody: html });
  return true;
}

function quitarTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'revisarRecordatorios') ScriptApp.deleteTrigger(t);
  });
}

/* ========================= DATOS ========================= */

function datos_() {
  asegurarEstructura_();
  const c = config_();
  let recordatorios = false;
  try {
    recordatorios = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'revisarRecordatorios'; });
  } catch (e) { recordatorios = false; }
  const bool = function (v) { return v === true || String(v).toUpperCase() === 'TRUE'; };
  const numOVacio = function (v) { return (v === '' || v === null || v === undefined || !isFinite(Number(v))) ? '' : Number(v); };

  return {
    config: {
      nombre1: c.nombre1, nombre2: c.nombre2, pct1: c.pct1, pct2: c.pct2, moneda: c.moneda,
      reparto: c.reparto, repartoPct1: c.repartoPct1, email1: c.email1, email2: c.email2, diasAviso: c.diasAviso,
      tienePin: !!c.pinHash, recordatorios: recordatorios
    },
    categorias: leer_(HOJAS.CATEGORIAS).map(function (k) {
      return {
        id: String(k.id), tipo: String(k.tipo) === 'ingreso' ? 'ingreso' : 'gasto', grupo: String(k.grupo || 'Otros'),
        nombre: String(k.nombre), persona: Number(k.persona) || 0, orden: Number(k.orden) || 0, activo: bool(k.activo)
      };
    }),
    presupuesto: leer_(HOJAS.PRESUPUESTO).map(function (p) {
      return { anio: Number(p.anio), mes: Number(p.mes), categoriaId: String(p.categoriaId), monto: Number(p.monto) || 0 };
    }),
    movimientos: leer_(HOJAS.MOVIMIENTOS).map(function (m) {
      const tipo = ['ingreso', 'gasto', 'liquidacion'].indexOf(String(m.tipo)) >= 0 ? String(m.tipo) : 'gasto';
      return {
        id: String(m.id), fecha: fechaTxt_(m.fecha), tipo: tipo, categoriaId: String(m.categoriaId || ''),
        persona: Number(m.persona) || 0, monto: Number(m.monto) || 0, nota: String(m.nota || ''),
        ambito: String(m.ambito) === 'personal' ? 'personal' : 'hogar', reparto: numOVacio(m.reparto),
        registradoPor: Number(m.registradoPor) || 0, revisar: bool(m.revisar),
        recurrenteId: String(m.recurrenteId || ''), destino: Number(m.destino) || 0
      };
    }),
    recurrentes: leer_(HOJAS.RECURRENTES).map(function (r) {
      return {
        id: String(r.id), nombre: String(r.nombre), categoriaId: String(r.categoriaId), monto: Number(r.monto) || 0,
        frecuencia: String(r.frecuencia) === 'anual' ? 'anual' : 'mensual', dia: Number(r.dia) || 1, mes: Number(r.mes) || 0,
        persona: Number(r.persona) || 0, activo: bool(r.activo)
      };
    }),
    metas: leer_(HOJAS.METAS).map(function (g) {
      return { id: String(g.id), nombre: String(g.nombre), objetivo: Number(g.objetivo) || 0, fechaMeta: fechaTxt_(g.fechaMeta), activo: bool(g.activo) };
    }),
    aportes: leer_(HOJAS.APORTES).map(function (a) {
      return { id: String(a.id), metaId: String(a.metaId), fecha: fechaTxt_(a.fecha), persona: Number(a.persona) || 0, monto: Number(a.monto) || 0, nota: String(a.nota || '') };
    })
  };
}

function config_() {
  if (_cacheConfig) return _cacheConfig;
  const raw = {};
  leer_(HOJAS.CONFIG).forEach(function (r) { raw[String(r.clave)] = r.valor; });
  _cacheConfig = {
    nombre1: texto_(raw.nombre1, 'Persona 1'),
    nombre2: texto_(raw.nombre2, 'Persona 2'),
    pct1: numero_(raw.pct1, 100),
    pct2: numero_(raw.pct2, 100),
    moneda: texto_(raw.moneda, 'C$'),
    reparto: texto_(raw.reparto, 'proporcional'),
    repartoPct1: numero_(raw.repartoPct1, 50),
    email1: texto_(raw.email1, ''),
    email2: texto_(raw.email2, ''),
    diasAviso: numero_(raw.diasAviso, 3),
    pinHash: texto_(raw.pinHash, '')
  };
  return _cacheConfig;
}

function setConfig_(c) {
  escribirTodo_(HOJAS.CONFIG, Object.keys(c).map(function (k) { return { clave: k, valor: c[k] }; }));
  _cacheConfig = null;
}

/* ========================= SEGURIDAD ========================= */

function hash_(pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SAL_PIN + pin, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function verificar_(pin) {
  asegurarEstructura_();
  const h = config_().pinHash;
  if (!h) return;
  const cache = CacheService.getScriptCache();
  const intentos = Number(cache.get('intentosPin') || 0);
  if (intentos >= 10) throw new Error('PIN_BLOQUEADO: Demasiados intentos. Espere 10 minutos.');
  if (!pin) throw new Error('PIN_REQUERIDO');
  if (hash_(String(pin)) !== h) {
    cache.put('intentosPin', String(intentos + 1), 600);
    throw new Error('PIN_INCORRECTO');
  }
}

/* ========================= ESTRUCTURA Y DATOS INICIALES ========================= */

function asegurarEstructura_() {
  if (_cacheHojas.__listo) return;
  Object.keys(HOJAS).forEach(function (k) { hoja_(HOJAS[k]); });

  if (!leer_(HOJAS.CONFIG).length) {
    setConfig_({ nombre1: 'Moisés', nombre2: 'Pareja', pct1: 100, pct2: 100, moneda: 'C$', reparto: 'proporcional', repartoPct1: 50, email1: '', email2: '', diasAviso: 3, pinHash: '' });
  }

  if (!leer_(HOJAS.CATEGORIAS).length) {
    const base = [
      ['ingreso', 'Ingresos', 'Amigos for Christ', 1], ['ingreso', 'Ingresos', 'Trabajo #2', 1], ['ingreso', 'Ingresos', 'Otros', 1],
      ['ingreso', 'Ingresos', 'Ingenio Monte Rosa', 2], ['ingreso', 'Ingresos', 'Trabajo #2', 2], ['ingreso', 'Ingresos', 'Otros', 2],
      ['gasto', 'Vivienda', 'Alquiler'], ['gasto', 'Vivienda', 'Seguro de alquiler'], ['gasto', 'Vivienda', 'Mantenimiento'],
      ['gasto', 'Vivienda', 'Electricidad'], ['gasto', 'Vivienda', 'Agua'], ['gasto', 'Vivienda', 'Aire acondicionado'],
      ['gasto', 'Vivienda', 'Gas'], ['gasto', 'Vivienda', 'Internet'], ['gasto', 'Vivienda', 'TV / Cable'],
      ['gasto', 'Transporte', 'Pago automóvil'], ['gasto', 'Transporte', 'Rodamiento / placas'], ['gasto', 'Transporte', 'Mantenimiento'],
      ['gasto', 'Transporte', 'Seguro del auto'], ['gasto', 'Transporte', 'Combustible'], ['gasto', 'Transporte', 'Estacionamiento'],
      ['gasto', 'Estudios de los hijos', 'Colegio / universidad'], ['gasto', 'Estudios de los hijos', 'Libros'],
      ['gasto', 'Estudios de los hijos', 'Útiles escolares'], ['gasto', 'Estudios de los hijos', 'Préstamo universitario'],
      ['gasto', 'Familia', 'Supermercado / comida'], ['gasto', 'Familia', 'Ropa de los hijos'], ['gasto', 'Familia', 'Gastos médicos'],
      ['gasto', 'Familia', 'Seguro de salud'], ['gasto', 'Familia', 'Seguro dental / visión'],
      ['gasto', 'Ahorro y deudas', 'Fondo para imprevistos'], ['gasto', 'Ahorro y deudas', 'Préstamos estudiantiles'],
      ['gasto', 'Ahorro y deudas', 'Tarjeta de crédito'], ['gasto', 'Ahorro y deudas', 'Ahorro para el retiro'],
      ['gasto', 'Ahorro y deudas', 'Inversiones'],
      ['gasto', 'Ocio', 'Suscripciones (Netflix, Spotify…)'], ['gasto', 'Ocio', 'Salidas a comer'],
      ['gasto', 'Ocio', 'Entretenimiento (cine, conciertos…)'],
      ['gasto', 'Viajes', 'Semana Santa'], ['gasto', 'Viajes', 'Vacaciones de fin de año'], ['gasto', 'Viajes', 'Otros viajes'],
      ['gasto', 'Varios', 'Regalos (Navidad, cumpleaños)'], ['gasto', 'Varios', 'Mascotas'], ['gasto', 'Varios', 'Lavandería'],
      ['gasto', 'Varios', 'Club / gimnasio'], ['gasto', 'Varios', 'Gastos en efectivo']
    ];
    const cats = base.map(function (b, i) {
      return { id: nuevoId_('c'), tipo: b[0], grupo: b[1], nombre: b[2], persona: b[3] || 0, orden: i + 1, activo: true };
    });
    escribirTodo_(HOJAS.CATEGORIAS, cats);

    const buscar = function (tipo, grupo, nombre, persona) {
      const c = cats.filter(function (x) { return x.tipo === tipo && x.grupo === grupo && x.nombre === nombre && (persona === undefined || x.persona === persona); })[0];
      return c ? c.id : null;
    };

    // Presupuesto inicial del mes en curso, tomado de la planilla del usuario
    if (!leer_(HOJAS.PRESUPUESTO).length) {
      const hoy = new Date();
      const semilla = [
        [buscar('ingreso', 'Ingresos', 'Amigos for Christ', 1), 12000],
        [buscar('ingreso', 'Ingresos', 'Ingenio Monte Rosa', 2), 9000],
        [buscar('gasto', 'Vivienda', 'Electricidad'), 300],
        [buscar('gasto', 'Vivienda', 'Gas'), 250],
        [buscar('gasto', 'Vivienda', 'Internet'), 100],
        [buscar('gasto', 'Vivienda', 'TV / Cable'), 340]
      ].filter(function (s) { return s[0]; });
      escribirTodo_(HOJAS.PRESUPUESTO, semilla.map(function (s) {
        return { anio: hoy.getFullYear(), mes: hoy.getMonth() + 1, categoriaId: s[0], monto: s[1] };
      }));
    }

    // Pagos fijos de ejemplo con los montos de la planilla
    if (!leer_(HOJAS.RECURRENTES).length) {
      const fijos = [
        ['Luz (Disnorte)', buscar('gasto', 'Vivienda', 'Electricidad'), 300, 15],
        ['Internet', buscar('gasto', 'Vivienda', 'Internet'), 100, 5],
        ['TV / Cable', buscar('gasto', 'Vivienda', 'TV / Cable'), 340, 5],
        ['Gas', buscar('gasto', 'Vivienda', 'Gas'), 250, 20]
      ].filter(function (f) { return f[1]; });
      escribirTodo_(HOJAS.RECURRENTES, fijos.map(function (f) {
        return { id: nuevoId_('r'), nombre: f[0], categoriaId: f[1], monto: f[2], frecuencia: 'mensual', dia: f[3], mes: '', persona: 0, activo: true };
      }));
    }
  }
  _cacheHojas.__listo = true;
}

/* ========================= UTILIDADES DE HOJA ========================= */

/**
 * Devuelve la hoja de cálculo de datos.
 * - Si el script está vinculado a una hoja (Extensiones > Apps Script), usa esa.
 * - Si es un proyecto independiente (script.google.com), crea la hoja
 *   "Presupuesto en Pareja – Datos" en su Drive la primera vez y guarda su ID.
 */
let _ss = null;
function ss_() {
  if (_ss) return _ss;
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) {
    const props = PropertiesService.getScriptProperties();
    const id = props.getProperty('SPREADSHEET_ID');
    if (id) {
      try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
    }
    if (!ss) {
      ss = SpreadsheetApp.create('Presupuesto en Pareja – Datos');
      ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());
      props.setProperty('SPREADSHEET_ID', ss.getId());
    }
  }
  _ss = ss;
  return ss;
}

function hoja_(def) {
  if (_cacheHojas[def.nombre]) return _cacheHojas[def.nombre];
  const ss = ss_();
  let sh = ss.getSheetByName(def.nombre);
  if (!sh) {
    sh = ss.insertSheet(def.nombre);
    sh.setFrozenRows(1);
  }
  // Crea o actualiza el encabezado (agrega columnas nuevas al actualizar desde la v1)
  const enc = sh.getRange(1, 1, 1, def.cols.length).getValues()[0];
  if (enc.join('|') !== def.cols.join('|')) {
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols]).setFontWeight('bold').setBackground('#e0f0ee');
  }
  _cacheHojas[def.nombre] = sh;
  return sh;
}

function leer_(def) {
  const sh = hoja_(def);
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, def.cols.length).getValues()
    .filter(function (r) { return r[0] !== '' && r[0] !== null; })
    .map(function (r) {
      const o = {};
      def.cols.forEach(function (c, i) { o[c] = r[i]; });
      return o;
    });
}

function escribirTodo_(def, objs) {
  const sh = hoja_(def);
  const ultima = sh.getLastRow();
  if (ultima > 1) sh.getRange(2, 1, ultima - 1, def.cols.length).clearContent();
  if (!objs.length) return;
  if (sh.getMaxRows() < objs.length + 1) sh.insertRowsAfter(sh.getMaxRows(), objs.length + 1 - sh.getMaxRows());
  (def.texto || []).forEach(function (c) {
    sh.getRange(2, def.cols.indexOf(c) + 1, objs.length, 1).setNumberFormat('@');
  });
  sh.getRange(2, 1, objs.length, def.cols.length).setValues(objs.map(function (o) {
    return def.cols.map(function (c) { return (o[c] === undefined || o[c] === null) ? '' : o[c]; });
  }));
}

/** Inserta o reemplaza por id. */
function upsert_(filas, fila, siExiste, siNuevo) {
  for (let i = 0; i < filas.length; i++) {
    if (String(filas[i].id) === String(fila.id)) {
      if (siExiste) siExiste(filas[i]);
      filas[i] = fila;
      return;
    }
  }
  if (siNuevo) siNuevo();
  filas.push(fila);
}

function conLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nuevoId_(prefijo) { return prefijo + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

function fechaTxt_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

function texto_(v, def) { return (v === undefined || v === null || String(v) === '') ? def : String(v); }
function numero_(v, def) { const n = Number(v); return (v === '' || v === undefined || v === null || !isFinite(n)) ? def : n; }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
