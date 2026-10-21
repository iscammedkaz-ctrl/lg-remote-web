# LG Remote (PWA)

Télécommande web pour TV LG webOS, utilisable depuis Safari sur iPhone, sans app native. Protocole SSAP en JavaScript pur (`app.js`).

## Utilisation
1. Ouvrez le site dans Safari, sur le même Wi-Fi que la TV (ou TV connectée au partage de connexion de l’iPhone, 172.20.10.x).
2. Saisissez l’IP de la TV (Réglages → Réseau → état) ou lancez Scanner.
3. Autoriser le certificat : ouvre https://IP:3001. Safari affiche « Cette connexion n’est pas privée » → Afficher les détails → Visiter ce site web. Une page blanche ou une erreur ensuite est normale. Revenez sur la télécommande.
4. Connecter, puis acceptez l’appairage sur la TV. IP et client-key sont gardées dans localStorage.

## Limites
- Certificat auto-signé : l’exception Safari peut disparaître au redémarrage, il faut alors refaire l’étape 3. Non testé sur un vrai iPhone ni une vraie TV.
- Mode écran d’accueil : impossible d’y accepter un certificat. En cas d’échec, utilisez la page dans Safari.
- Scan : ni SSDP ni mDNS dans un navigateur. Sans certificat accepté, le scan ne donne que des candidats.
- Wake-on-LAN impossible (pas d’UDP dans un navigateur).
- ws://:3000 bloqué depuis une page HTTPS.
- iOS coupe les WebSockets en arrière-plan : reconnexion automatique au retour.
