# HausAnker XR – WebXR-Minimaltest

Virtuelle Post-its im Passthrough der Meta Quest 3 setzen, als persistente
WebXR-Anker speichern und nach einem Neustart an derselben Stelle wiederfinden.

## So testest du

1. App starten, in der HA-Seitenleiste **HausAnker** öffnen (auch im Quest-Browser).
2. Auf den Link `https://<HA-Adresse>:8443/` tippen. Passt das Zertifikat nicht
   zur Adresse, „Erweitert“ → „Weiter zu …“ wählen.
3. Text eingeben, Farbe wählen, **AR starten**.

| Eingabe | Wirkung |
|---|---|
| Trigger / Pinch | Post-it setzen (auf erkannter Fläche, sonst 40 cm vor dem Controller) |
| Grip nahe einem Post-it | Post-it löschen (inkl. persistentem Anker) |
| A / X | Raum-Scan (Ebenen + Mesh) ein/aus |
| B / Y | Nächste Farbe |

Die Statusanzeige hängt am linken Controller. Alle Meldungen aus dem Headset
landen zusätzlich im Log dieser App.

## Optionen

- `certfile` / `keyfile`: Zertifikat im `/ssl`-Ordner (Standard: das Let's-Encrypt-
  Zertifikat der Duck-DNS-App). Fehlt es, erzeugt die App ein selbstsigniertes.

## Grenzen

- Der Quest-Browser erlaubt max. 8 persistente Anker pro Website.
- Port 8443 hat keine Anmeldung – nur im Heimnetz nutzen, nicht freigeben.
- Für Ebenen/Mesh muss in der Quest die Raumeinrichtung (Space Setup) gemacht sein.
