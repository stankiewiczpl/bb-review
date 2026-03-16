# Bitbucket AI Code Review

Narzędzie do automatycznego code review PR-ów z Bitbucket przy użyciu Claude CLI. Pobiera diff z Bitbucket API, wysyła do Claude do analizy, wyświetla sugestie w przeglądarce i publikuje zatwierdzone komentarze z powrotem do Bitbucket.

## Wymagania

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) zainstalowany globalnie

## Uruchomienie

```bash
npm install
node index.js          # port 5177, auto-open browser
node index.js --port 3000
```

## Jak działa

1. Podajesz credentials Bitbucket + workspace/repo/PR
2. Serwer pobiera info o PR i diff z Bitbucket API
3. (Opcjonalnie) Pobiera powiązany ticket z Jira
4. Claude analizuje diff (z kontekstem lokalnego repo jeśli podano ścieżkę)
5. Przeglądasz komentarze jeden po drugim — zatwierdzasz lub odrzucasz
6. Zatwierdzone komentarze publikowane do Bitbucket
7. Na końcu możesz zatwierdzić PR lub zażądać zmian

## Tokeny i uprawnienia

### Bitbucket — API Token (wymagany)

Utwórz: **Bitbucket → Settings → Atlassian account settings → Security → API tokens → Create API token with scopes**

Wymagane scopes:

| Scope | Opis |
|---|---|
| `read:user:bitbucket` | Identyfikacja użytkownika (test połączenia) |
| `read:repository:bitbucket` | Odczyt repozytoriów i diff |
| `read:pullrequest:bitbucket` | Odczyt pull requestów |
| `write:pullrequest:bitbucket` | Komentarze, approve, request changes |

### Jira — API Token (opcjonalny)

Jeśli chcesz, żeby Claude miał kontekst ze zgłoszenia Jira powiązanego z PR-em. Klucz ticketa wykrywany automatycznie z tytułu PR lub nazwy brancha (np. `S3-10741`).

Utwórz: **Atlassian account → Security → API tokens → Create API token with scopes**

Wymagane scopes:

| Scope | Opis |
|---|---|
| `read:jira-work` | Odczyt zgłoszeń (tytuł, opis, status, typ) |

> Token Jira jest **osobnym tokenem** — nie można łączyć scopów Bitbucket i Jira w jednym tokenie.

### Kontekst lokalnego repo (opcjonalny)

Podaj ścieżkę do lokalnego klona repozytorium — Claude użyje go jako kontekstu do głębszej analizy (importy, zależności, konwencje). Jeśli w projekcie skonfigurowany jest Serena MCP, Claude użyje go do semantycznego przeszukiwania kodu.

## Konfiguracja

Wszystkie ustawienia (credentials, workspace, repo, Jira domain) zapisywane w `localStorage` przeglądarki. Nic nie jest przechowywane na serwerze.

## Testy

```bash
npm test                         # Wszystkie testy
npm run test:parser              # Diff parser
npm run test:bitbucket           # Bitbucket API client
npm run test:claude              # Claude prompt + JSON parsing
npm run test:server              # Express API endpoints
```

## Architektura

- **ES Modules** — `"type": "module"` w package.json
- **Frontend** — vanilla JS SPA w `public/index.html` (bez frameworka)
- **Streaming** — SSE (`/api/stream`) do przesyłania postępu w czasie rzeczywistym
- **Brak bazy danych** — logi zapisywane jako `logs/{prId}_{timestamp}.json`

### Moduły

| Plik | Opis |
|---|---|
| `src/server.js` | Express routes, SSE, pipeline review |
| `src/bitbucket.js` | Bitbucket API 2.0 client |
| `src/claude.js` | Spawn `claude -p` subprocess, stream-json parsing |
| `src/jira.js` | Jira REST API client (opcjonalny) |
| `src/parser.js` | Unified diff parser |
| `review-agent.md` | System prompt dla Claude (instrukcje code review) |
