# Presupuesto en Pareja

App para llevar los ingresos, gastos, metas de ahorro y pagos fijos de una pareja.
Se instala en el celular como una app y **funciona sin internet**: todo se guarda en el
teléfono y, cuando hay señal, se sincroniza con una hoja de Google para que los dos vean lo mismo.

## Qué incluye

- Resumen del mes: disponible, ingresos aportados, gastos, ahorro y proyección al cierre.
- Movimientos: gastos del hogar o personales, quién pagó y cómo se divide.
- Entre ustedes: quién le debe a quién y registro de pagos para quedar a mano.
- Presupuesto mensual por categoría y metas de ahorro.
- Pagos fijos con estado (pagado, pendiente, vencido) y recordatorios por correo.
- Resumen del año con la planilla de 12 meses.
- Copia de seguridad en archivo JSON.

## Estructura

```
index.html             La app completa (HTML, CSS y JS)
sw.js                  Service worker: guarda la app para usarla sin internet
manifest.webmanifest   Datos para instalarla en el celular
icons/                 Iconos de la app
fonts/                 Fuentes Bricolage Grotesque y Onest (locales, sin depender de Google Fonts)
vendor/chart.umd.js    Chart.js 4.4.1 (local)
apps-script/           Code.gs: hoja de Google que sincroniza a los dos celulares (opcional)
```

## 1. Publicar en GitHub Pages

1. Cree un repositorio nuevo en GitHub, por ejemplo `presupuesto-pareja`.
2. Suba **todo el contenido** de esta carpeta a la raíz del repositorio, incluido `.nojekyll`.
   Desde la terminal:
   ```bash
   git init
   git add .
   git commit -m "Presupuesto en Pareja"
   git branch -M main
   git remote add origin https://github.com/USUARIO/presupuesto-pareja.git
   git push -u origin main
   ```
3. En GitHub, vaya a **Settings → Pages**. En *Source* elija **Deploy from a branch**,
   rama **main** y carpeta **/ (root)**. Guarde.
4. En uno o dos minutos la app queda en `https://USUARIO.github.io/presupuesto-pareja/`.

> GitHub Pages es público: cualquiera puede abrir la app, pero **no ve sus datos**.
> Los datos viven en cada celular y, si conectan la hoja, en su Google Drive.

## 2. Instalar en el celular

- **Android (Chrome):** abra la URL. Toque **Más → Instalar en este celular**, o el menú ⋮ → **Instalar app**.
- **iPhone (Safari):** abra la URL, toque **Compartir → Agregar a inicio**.

Desde ese momento abre sin internet, como cualquier app.

## 3. Sincronizar entre los dos celulares (opcional)

Sin este paso, cada celular guarda solo sus propios datos.

1. Cree una hoja nueva en [sheets.new](https://sheets.new) con su Gmail personal.
2. Vaya a **Extensiones → Apps Script**, pegue el contenido de `apps-script/Code.gs` y guarde.
   No hace falta el archivo Index: en esta versión la app vive en GitHub.
3. Elija la función `instalar` → **Ejecutar** → acepte los permisos.
4. **Implementar → Nueva implementación → Aplicación web**:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
5. Copie la URL que termina en `/exec`.
6. En la app de cada celular: **Más → Sincronizar con su pareja**, pegue la URL y toque **Conectar**.
   - Si el celular ya tenía datos y la hoja está vacía, se suben a la hoja.
   - Si los dos tienen datos, la app pregunta cuáles conservar.
7. Con la app conectada se activan los **recordatorios por correo** y el **PIN**, en **Más → Ajustes**.

### Cómo funciona sin internet

Cada cambio se guarda al instante en el celular y entra en una cola. Cuando vuelve la señal
(o al abrir la app), la cola se envía a la hoja en orden y el celular recibe lo que registró
la pareja. Arriba aparece un aviso cuando hay cambios pendientes de enviar.

## Publicar una actualización

1. Haga los cambios y súbalos a GitHub.
2. En `sw.js`, cambie la línea `const VERSION = 'pp-v1.0.0';` (por ejemplo a `pp-v1.0.1`).
   Así los celulares descargan la versión nueva la próxima vez que abran la app con internet.
3. Si cambió `Code.gs`: en Apps Script, **Implementar → Administrar implementaciones → ✏️ →
   Nueva versión**. La URL `/exec` no cambia.

## Probar en la computadora

El service worker necesita un servidor (no funciona abriendo el archivo directamente):

```bash
python3 -m http.server 8000
```

y abra `http://localhost:8000`.
