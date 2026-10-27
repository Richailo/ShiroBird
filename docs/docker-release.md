# ShiroBird — publiczne obrazy Docker (wersja testowa 0.1.0-rc.1)

Wydanie składa się z czterech niezależnych obrazów:
- `ghcr.io/richailo/shirobird:0.1.0-rc.1` — panel i API;
- `ghcr.io/richailo/shirobird-customize:0.1.0-rc.1` — ustawienia widoczności;
- `ghcr.io/richailo/shirobird-bridge:0.1.0-rc.1` — mostek do oficjalnego NetBird Dashboard;
- `ghcr.io/richailo/shirobird-native-flow:0.1.0-rc.1` — opcjonalny odbiornik ruchu.

Wszystkie cztery obrazy zostały opublikowane w GHCR i są dostępne publicznie
bez logowania, w architekturach **linux/amd64** i **linux/arm64**.
[Wydanie v0.1.0-rc.1](https://github.com/Richailo/ShiroBird/releases/tag/v0.1.0-rc.1)
ma status **Pre-release**, nie jest wydaniem stabilnym. ShiroBird nie należy do
programu Docker Official Images ani do oficjalnych produktów NetBird.

## Instalacja na nowym serwerze

Wymagania: Docker Engine, Compose v2, openssl; istniejący self-hosted NetBird
w kontenerach `netbird-dashboard` i `netbird-server` dla wersji zintegrowanej.

```bash
git clone --branch v0.1.0-rc.1 --depth 1 https://github.com/Richailo/ShiroBird.git
cd ShiroBird
sudo SHIROBIRD_INSTALL_MODE=pull bash scripts/install-release.sh
```

Tryb `pull` pobiera gotowe obrazy GHCR. Alternatywnie `SHIROBIRD_INSTALL_MODE=build`
buduje je lokalnie. Skrypt wykrywa istniejący NetBird, generuje dwa losowe sekrety,
zachowuje dane w `./data` i **nie modyfikuje kontenerów NetBird**. Nie uruchamiaj
go w katalogu istniejącej instalacji ShiroBird — instalator celowo odmawia nadpisania.
Nie kopiuj `.env.example` do `.env` bez zastąpienia przykładowych tokenów.

## NetBird / Nginx Proxy Manager

W reverse proxy przełącz WYŁĄCZNIE upstream strony Dashboard z
`netbird-dashboard:8080` / adresu hosta `:8080` na adres hosta `:8082`.
Nie zmieniaj tras management API, OIDC, gRPC, relay ani WebSocket.
Port 8082 jest domyślnie związany tylko z 127.0.0.1; jeżeli proxy działa na
innym hoście, ustaw `SHIROBIRD_BRIDGE_BIND=ADRES_PRYWATNY` w `.env`,
zrestartuj stack i ogranicz dostęp do portu regułami zapory.
Publiczny ruch powinien przechodzić wyłącznie przez istniejące HTTPS.

## Compose / Portainer

Dla samego panelu: `compose.release.yaml`.
Zintegrowany NetBird: `compose.release.yaml` i `compose.release.netbird.yaml`.
Do lokalnego budowania dodaj odpowiednio `compose.release.build.yaml`
oraz `compose.release.build.netbird.yaml`.
W Portainerze użyj publicznych obrazów GHCR z przypiętym tagiem `0.1.0-rc.1`.
Wymagane są plik `.env` z unikalnymi sekretami oraz katalog `./data`
z właścicielem UID 65532. Wszystkie obrazy i tagi wersjonuj łącznie.

## Traffic Flow (opcjonalne)

Do natywnych zdarzeń dodaj `compose.release.native.yaml`. Jego uruchomienie
wymaga kompatybilnego serwera zarządzania NetBird oraz dwóch istniejących
plików sekretów: `extensions/native-flow/flow-secret` i
`extensions/native-flow/api-token`. W żadnym obrazie nie umieszczaj sekretów.
Lokalny build tego modułu wymaga jeszcze `compose.release.build.native.yaml`.
Włączenie samego odbiornika nie aktywuje raportowania peerów NetBird.
Patrz `extensions/native-flow/README.md`.

## Testy, backup, aktualizacja i powrót

```bash
docker compose -f compose.release.yaml -f compose.release.netbird.yaml config -q
docker compose -f compose.release.yaml -f compose.release.netbird.yaml ps
curl -fsS http://127.0.0.1:8082/shirobird/healthz
tar -czf shirobird-data-backup.tar.gz data/
```

Przed aktualizacją z istniejącej instalacji zrób kopię `data/` i `.env`
w miejscu chronionym. Nie uruchamiaj instalatora na istniejącym kontenerze
`shirobird` — celowo odmawia on nadpisania produkcji. Po opublikowaniu nowej
wersji zaktualizuj cztery tagi razem i użyj `docker compose pull && docker
compose up -d`. W razie problemów przywróć poprzednie tagi lub proxy Dashboard
na oryginalny upstream 8080. Nie usuwaj wolumenów podczas rollbacku.

## Publikacja własnego wydania

Dla **kolejnej** wersji utwórz nowy tag (nie używaj ponownie `v0.1.0-rc.1`),
np. `git tag -a v0.1.0-rc.2 -m 'ShiroBird RC2' && git push origin v0.1.0-rc.2`.
Workflow `.github/workflows/publish-docker.yml` testuje projekt i publikuje
obrazy linux/amd64 i linux/arm64 do GitHub Container Registry, używając
`GITHUB_TOKEN` (repozytorium wymaga uprawnienia Packages: write).
W ustawieniach pakietów GHCR włącz publiczny odczyt, jeśli obraz ma być publiczny.
Przed wydaniem stabilnym przeprowadź test aktualizacji oraz wdrożenia na czysto.

Do Docker Hub potrzebne są własny namespace i uwierzytelnienie. Przykład:
```bash
docker login
docker tag ghcr.io/richailo/shirobird:0.1.0-rc.1 TWOJKONTO/shirobird:0.1.0-rc.1
docker push TWOJKONTO/shirobird:0.1.0-rc.1
```

Analogicznie opublikuj pozostałe trzy obrazy oraz zmień zmienne
`SHIROBIRD_RELEASE_*_IMAGE` w `.env`. Posiadanie obrazu na Docker Hub nie
nadaje automatycznie oznaczenia `Docker Official Image`.

## Instalacja offline z archiwum obrazów (Linux amd64)

Pobierz trzy załączniki z [GitHub Release](https://github.com/Richailo/ShiroBird/releases/tag/v0.1.0-rc.1)
do podkatalogu `releases/` na docelowym serwerze (lub przenieś je tam offline).

```bash
mkdir -p shirobird-offline/releases
cd shirobird-offline
# Umieść tu pobrane pliki: releases/shirobird-*.tar.gz oraz releases/shirobird-0.1.0-rc.1.sha256
sha256sum -c releases/shirobird-0.1.0-rc.1.sha256
mkdir ShiroBird
tar -xzf releases/shirobird-docker-0.1.0-rc.1-src.tar.gz -C ShiroBird
gzip -dc releases/shirobird-images-0.1.0-rc.1-linux-amd64.tar.gz | docker load
cd ShiroBird
sudo SHIROBIRD_INSTALL_MODE=load bash scripts/install-release.sh
```

Archiwum źródeł nie ma nadrzędnego katalogu. W trybie `load` Docker
korzysta z lokalnie załadowanych obrazów, bez pobierania i bez budowania.
Archiwum obrazów offline jest przeznaczone tylko dla Linux AMD64.
