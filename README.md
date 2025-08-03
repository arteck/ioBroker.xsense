![Logo](admin/xsense.png)
# ioBroker.xsense
=================

[![NPM](https://nodei.co/npm/iobroker.xsense.png?downloads=true)](https://nodei.co/npm/iobroker.xsense/)

[![NPM version](http://img.shields.io/npm/v/iobroker.xsense.svg)](https://www.npmjs.com/package/iobroker.xsense)
[![Downloads](https://img.shields.io/npm/dm/iobroker.xsense.svg)](https://www.npmjs.com/package/iobroker.xsense)
![GitHub last commit](https://img.shields.io/github/last-commit/arteck/ioBroker.xsense)
![GitHub issues](https://img.shields.io/github/issues/arteck/ioBroker.xsense)[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/arteck/ioBroker.xsense/blob/master/LICENSE)

</br>
**Version:** </br>

![Number of Installations](http://iobroker.live/badges/xsense-installed.svg)
![Beta](https://img.shields.io/npm/v/iobroker.xsense.svg?color=red&label=beta)
![Stable](https://iobroker.live/badges/xsense-stable.svg)


xsense Adapter for ioBroker
------------------------------------------------------------------------------

Dieser ioBroker-Adapter ermöglicht die Integration von XSense-Geräten in das ioBroker Smart-Home-System. 
Er wurde entwickelt, um Daten von XSense-Rauchmeldern, CO-Meldern und weiteren kompatiblen Geräten zu empfangen und für Automatisierungen und Überwachungen im ioBroker bereitzustellen.
Der Adapter basiert auf der Kommunikation mit dem XSense-Cloud-Server und bietet eine einfache Möglichkeit, XSense-Geräte in bestehende ioBroker-Setups zu integrieren.
Es ist eine XSense Bridge SBS50 notwendig.


## ❗ ACHTUNG 
 ein zu häufiges Abfrageintervall (default : 5 min)  verkürzt die Batterielebensdauer der Geräte, da diese explizit IMMER geweckt werden
 Der Adapter dient nicht der Alarmierung, es soll eher zur überwachung der Gerätebatterie dienen.


------------------------------------------------------------------------------

🔧 Unterstützte Geräte
- Rauchmelder
- Kohlenmonoxidmelder
- Hitzemelder
- Wassermelder
- Hygrometer
- Basisstationen (sofern unterstützt)


⚠️ Voraussetzungen
- Ein XSense-Konto mit registrierten Geräten
- Internetverbindung für Cloud-Kommunikation
- **Python mind. Version 3.10.0** in der [öffentlich publizierten Version](https://www.python.org/downloads/source/) erforderlich (für die X-Sense-Kommunikation via Python-Wrapper).



📦 Vorbereitung

Da XSense keine parallele Anmeldung in App und Drittanbieter-Software erlaubt, empfiehlt sich folgendes Vorgehen:

- Zweitkonto erstellen: Erstelle in der XSense-App ein zweites Konto.
- Login mit dem neuen Konto, dann ausloggen
- Login mit dem alten Konto und 
- Geräte teilen: Teile die gewünschten Geräte vom Hauptkonto mit dem neuen Konto.
- dann Login wieder mit dem neuen Konto und einladung akzeptieren
- erst dann 
- Zugangsdaten im Adapter eintragen: Verwende das Zweitkonto für die Verbindung im ioBroker.

  ### oder man nutzt nur ein Konto, mit der prämisse dass man ständig ausgeloggt wird

------------------------------------------------------------------------------

## 🚀 Installation Python falls noch -KEIN- installiert ist

es muss eine offizielle und veröffentliche Python Version sein

💻 Windows

1. **Python installieren**
   - Download: [https://www.python.org/downloads/windows/](https://www.python.org/downloads/windows/)
   - Während der Installation **"Add Python to PATH" aktivieren**
   - Danach prüfen:
     ```powershell
     python --version
     pip --version
     ```
      danach im Objekten unter xsense.0.info.callPython -> python eintragen. Als detault Wert steht dort python3.



     
🐧 Linux 🐳 Docker

  - passiert automatisch, nur in Adapter Einstellungen auswählen welche Version bevorzugt wird

------------------------------------------------------------------------------

 
  
------------------------------------------------------------------------------
#  ------------------------------------------------------------------------------

## ❗ bei Problemen 

ist dir richtige version installiert aber der Adapter hat schon was falsches gezogen 
zuerst die Umgebung löschen
```
  rm -Rf /home/iobroker/.cache/autopy/venv/xsense-env
 ```
dann Adapter neu starten
sollte es immer noch nicht laufen die Datei /home/iobroker/.cache/autopy/venv/xsense-env/pyvenv.cfg sich anschauen
hier stehen Python Versionen die für die Umgebung relevant sind. Diese gegenenfals anpassen.
ist die Datei nicht vorhanden habt ihr nicht lang genug gewartet bis der Adapter gestartet wurde.

------------------------------------------------------------------------------
------------------------------------------------------------------------------


<img width="1029" height="438" alt="grafik" src="https://github.com/user-attachments/assets/86e4fd1c-1d4e-4234-a2ad-48b8dd9f418e" />

    
<img width="1387" height="779" alt="grafik" src="https://github.com/user-attachments/assets/f065c43d-125b-4ca4-a053-bbf4b926e1f6" />


------------------------------------------------------------------------------

## Changelog
### 0.0.13 (2025-08-03)
* (arteck) fix io-package

### 0.0.12 (2025-07-30)
* (arteck) fix util

### 0.0.11 (2025-07-30)
* (arteck) fix util missing

### 0.0.10 (2025-07-30)
* (arteck) pip auto install for linux

### 0.0.9 (2025-07-30)
* (arteck) fix callPython Object

### 0.0.8 (2025-07-30)
* (arteck) add callPython Object

### 0.0.6 (2025-07-29)
* (arteck) new error message

### 0.0.5 (2025-07-29)
* (arteck) serialnumber is a string

### 0.0.4 (2025-07-28)
* (arteck) fix language

### 0.0.3 (2025-07-28)
* (arteck) modify Debug method

### 0.0.2 (2025-07-28)
* (arteck) initial release

### 0.0.1 (2025-07-27)
* (arteck) initial release

## 📜 Lizenz

MIT License – siehe [LICENSE](https://github.com/arteck/ioBroker.xsense/blob/main/LICENSE) für Details.
