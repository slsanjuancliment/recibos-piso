# Recibos piso

Una web app para iPhone que fotografía los comprobantes del cajero (alquiler, luz…) y los guarda ordenados en **Google Drive**:

```
Mi unidad/
└── Recibos piso/
    └── 2026/
        ├── Alquiler/2026-11 Alquiler - 650,00 €.jpg
        └── Luz/2026-10 Luz - 48,37 €.jpg
```

- La app solo tiene acceso a los archivos que ella misma crea en tu Drive (permiso `drive.file`).
- Si falla la subida (sin cobertura, sesión caducada…), la foto se queda guardada en el móvil y se sube después.
- La opción "Mejorar contraste" pasa el ticket a blanco y negro y oscurece el texto descolorido de la impresora térmica.
- No hay servidor ni base de datos. Todo es gratis: GitHub Pages para alojar la app y los 15 GB de Google Drive.

## 1. Publicar la app (GitHub Pages)

La app se publica en `https://<tu-usuario>.github.io/recibos-piso/`.

## 2. Crear el ID de cliente de Google (una sola vez, unos 5 minutos)

1. Entra en <https://console.cloud.google.com/> con tu cuenta de Google → **Crear proyecto** → nombre: `Recibos piso`.
2. **APIs y servicios → Biblioteca** → busca **Google Drive API** → **Habilitar**.
3. **APIs y servicios → Pantalla de consentimiento de OAuth** (o "Google Auth Platform"):
   - Tipo de usuario: **Externo**. Nombre de la app: `Recibos piso`. Pon tu email como asistencia y contacto.
   - En **Público / Usuarios de prueba**, añade tu propio email de Gmail.
   - En **Acceso a datos / Permisos**, añade `.../auth/drive.file`.
   - Puedes dejarla en modo **Prueba**. Solo la usas tú, así que no hace falta que Google la verifique.
4. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo: **Aplicación web**.
   - **Orígenes de JavaScript autorizados**: `https://<tu-usuario>.github.io`
   - **URIs de redirección autorizados**: `https://<tu-usuario>.github.io/recibos-piso/` (con la barra final)
   - Para probar en el Mac, añade también `http://localhost:8765` en los dos campos (en el segundo, con la barra final).
5. Copia el **ID de cliente** (`xxxx.apps.googleusercontent.com`) y pégalo en `config.js` → `GOOGLE_CLIENT_ID`. Después vuelve a publicar la app.

> El ID de cliente no es secreto; puede estar en un repositorio público sin problema.

## 3. Instalar en el iPhone

1. Abre `https://<tu-usuario>.github.io/recibos-piso/` en **Safari**.
2. Botón **Compartir** → **Añadir a pantalla de inicio**.
3. Abre la app desde el icono → **Conectar Google Drive** → elige tu cuenta y acepta. Google avisará de que la app no está verificada: pulsa **Continuar**, porque la app es tuya.

Google da sesiones de 1 hora. Cuando caduca, la app vuelve a conectar sola (verás un parpadeo de la pantalla de Google), sin pedirte la contraseña.

## Probar en el Mac

```bash
python3 -m http.server 8765
```

Abre <http://localhost:8765>.
