# Mégathèque

Appli web installable (PWA) pour garder ses dossiers MEGA publics sous la main et lire leurs vidéos en streaming sur le téléphone, sans rien télécharger.

- Colle un lien `mega.nz/folder/…#…` (ou partage-le depuis l'appli MEGA) : le dossier est enregistré.
- Navigation dans les sous-dossiers, filtres Tout / Vidéos / Dossiers, tri par nom, date ou taille, recherche.
- Lecture avec avance rapide : le service worker (`sw.js`) récupère le fichier chiffré chez MEGA par morceaux et le déchiffre à la volée (AES-128-CTR).

## Confidentialité

Il n'y a aucun serveur. Les liens (qui contiennent la clé de déchiffrement) restent dans le stockage local du téléphone. Le téléphone parle directement à MEGA, avec son propre quota de transfert.

## Mise en ligne

Ce sont des fichiers statiques : GitHub Pages, Cloudflare Pages ou Netlify suffisent. Le HTTPS est obligatoire pour le service worker.

Bibliothèque utilisée : [megajs](https://github.com/qgustavor/mega) 1.3.10 (MIT), copiée dans `vendor/`.
