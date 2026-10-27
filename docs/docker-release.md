# ShiroBird — produkcyjne obrazy Docker (wersja 0.1.0-rc.1)

Wydanie składa się z czterech niezależnych obrazów:
- `ghcr.io/richailo/shirobird:0.1.0-rc.1` — panel i API;
- `ghcr.io/richailo/shirobird-customize:0.1.0-rc.1` — ustawienia widoczności;
- `ghcr.io/richailo/shirobird-bridge:0.1.0-rc.1` — mostek do oficjalnego NetBird Dashboard;
- `ghcr.io/richailo/shirobird-native-flow:0.1.0-rc.1` — opcjonalny odbiornik ruchu.

To nazwy DOCELOWE. Obrazy są zbudowane lokalnie. Pojawią się w GHCR dopiero po
przesłaniu tych plików do repozytorium i opublikowaniu tagu `v0.1.0-rc.1`.
Nie są częścią programu Docker Official Images ani oficjalnego produktu NetBird.

## Instalacja na nowym serwerze

Wymagania: Docker Engine, Compose v2, openssl; istniejący self-hosted NetBird
w kontenerach `netbird-dashboard` i `netbird-server` dla wersji zintegrowanej.

```bash
git clone https://github.com/Richailo/ShiroBird.git
cd ShiroBird
sudo SHIROBIRD_INSTALL_MODE=build bash scripts/install-release.sh
```

Tryb build nie wymaga wcześniejszej publikacji obrazów. Po udostępnieniu ich w
GHCR ustaw `SHIROBIRD_INSTALL_MODE=pull`. Skrypt wykrywa NetBird, generuje
dwa losowe sekrety, zachowuje dane w `./data` i NIE dotyka kontenerów NetBird.

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
W Portainerze stosuj wersję zdalną (GHCR) dopiero po opublikowaniu obrazów.
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

Po zsynchronizowaniu kodu z repozytorium GitHub utwórz podpisany tag,
np. `git tag -s v0.1.0-rc.1 && git push origin v0.1.0-rc.1`.
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

```bash
mkdir ShiroBird && tar -xzf shirobird-docker-0.1.0-rc.1-src.tar.gz -C ShiroBird
cd ShiroBird
gzip -dc ../shirobird-images-0.1.0-rc.1-linux-amd64.tar.gz | docker load
sudo SHIROBIRD_INSTALL_MODE=load bash scripts/install-release.sh
```

Archiwum źródeł jest spakowane bez katalogu nadrzędnego, dlatego rozpakuj
je do pustego katalogu ShiroBird. W trybie load nie ma pobierania ani budowania.
