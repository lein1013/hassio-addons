# Changelog

## 0.4.0

- Menü am linken Controller mit beschrifteten Knöpfen: ＋ Notiz · 🎙 Diktat · 🎬 Video · 📋 Übersicht ·
  🗺 Karte · 🎨 Farbe. X blendet das Menü aus/ein (startet keine Aufnahme mehr).
- Video-Rekorder als eigener Ablauf: Aufnahme starten → Stopp & behalten / Verwerfen → Ansehen,
  Titel sprechen, Neu aufnehmen, Verwerfen → mit Trigger platzieren.
- Video-Titel automatisch: Das Gesprochene der Aufnahme wird erkannt; ein Kurztitel entsteht über den
  Konversationsagenten von Home Assistant (Option `title_agent`, Standard: erster eigener Agent, z. B. Ollama),
  sonst aus dem ersten Satz. Transkript in der Übersicht. Titelzeile antippen = Titel sprechen.
- Notiz antippen = Text sprechen.
- Grundriss per Tiefensensor: ein Fächer aus Treffertest-Strahlen tastet beim Herumgehen Wände und
  freie Flächen ab (10-cm-Belegungsraster, wird mit jedem Rundgang genauer). Ohne Raum-Scan.
- Notizen haften beim Platzieren an Wänden/Möbeln, wenn diese näher als der Vorschau-Abstand sind.
- Übersicht in Mixed Reality: Liste mit Filter, abhaken, ➜ Zeigen (gelbe Linie), als Nächstes platzieren, löschen.
- Karte frei positionierbar: mit Grip greifen; Modi 👁 folgt dem Blick (an der gewählten Stelle) · 📌 fix im Raum ·
  ✋ am Controller · ✕ aus.
- Übersicht am PC: Grundriss als Rasterbild mit Wänden, freien Flächen, Ankerpunkten und Einträgen.

## 0.3.1

- Bewegungsbereich „Ganze Wohnung“ (WebXR-Referenzraum `unbounded`) als Standard: Der
  Quest-Browser blendet keine Begrenzung ein, man kann sich frei durch die Wohnung bewegen.
  Anker werden dabei im `local`-Raum angelegt. Auswahl unter „Erweitert“ (unbounded / local / local-floor).

## 0.3.0

- Keine Raum-/Begrenzungsabfrage mehr: Standard-Referenzraum `local` statt `local-floor`
  (Boden-Referenz und Raum-Scan optional unter „Erweitert“).
- Video-Anleitungen: Kamera-Auswahl mit Live-Vorschau – die virtuelle Kamera der Quest liefert
  in Mixed Reality nur Schwarz; die Passthrough-Kamera wird bevorzugt.
- Aktionsleiste an jeder Notiz: ✓ abhaken, 🎙 sprechen, ✥ verschieben, 🎨 Farbe, 🗑 löschen;
  bei Videos ▶, 🎙, ✥, 🗑. Bedienbar auch mit Handtracking.
- Menü am linken Controller: ＋ Notiz, 🎙 Diktat, ● Video, 🗺 Karte, ▦ Scan-Anzeige.
- Trigger ins Leere legt keine leeren Notizen mehr an – nur noch, was in der Warteschlange steht.
- Hauskarte: gelaufene Wege (und mit Raum-Scan Wände) werden relativ zum Heimat-Ankerpunkt
  gespeichert; Minimap oben rechts oder am rechten Controller, Draufsicht in der Übersicht.
- Verlorene Ankerpunkte werden erkannt, ihre Notizen landen wieder in der Warteschlange.

## 0.2.0

- Umbenannt in **Home Notes XR** (neuer Slug `homenotes_xr`, Daten starten leer).
- Spracheingabe: A halten zum Diktieren, Erkennung über die Spracherkennung von Home Assistant.
- Notizen verschieben (Grip), löschen (B zweimal), abhaken (Trigger), Farbe ändern (Y).
- Funktioniert ohne Raum-Scan: freie Platzierung mit einstellbarem Abstand; Raum-Scan optional.
- Video-Anleitungen: mit X aufnehmen, mit Trigger platzieren, im Raum abspielen.
- Ankerpunkte statt eines Ankers pro Notiz – umgeht das 8-Anker-Limit, räumt verwaiste Anker auf.
- Desktop-Übersicht in der HA-Seitenleiste: Post-its und Videos filtern, bearbeiten,
  abhaken, löschen, neu platzieren, neue Notizen anlegen.

## 0.1.1 (HausAnker XR)

- Ingress-Zugriff aus dem gesamten Home-Assistant-Netz erlauben.

## 0.1.0 (HausAnker XR)

- Erster Minimaltest: Post-its setzen/löschen, persistente Anker, Ebenen- und Mesh-Anzeige.
