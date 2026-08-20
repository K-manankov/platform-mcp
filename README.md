# platform-mcp

MCP-сервер для инфраструктурных сервисов кластера `sonar-prod` — Argo CD, Vault и
Keycloak — с SSO-входом (GitLab для Argo/Vault, FreeIPA для Keycloak).

## Зачем

Агенту в редакторе нужен доступ к Argo CD, Vault и Keycloak, но выдавать ему
сервисную учётку нельзя: в аудите вместо человека появится общий аккаунт, а права
окажутся шире, чем у любого конкретного разработчика.

Этот пакет ставится локально и проводит обычный SSO-вход через браузер. Дальше он
выполняет команды **от имени вошедшего пользователя**: в аудит-логах виден реальный
логин, а права ровно те, что даёт членство в группах.

Инструмент на сервис ровно один — `argocd_exec`, `vault_exec` и `keycloak_exec`,
принимающие аргументы командной строки. Под капотом — официальные CLI (`argocd`,
`vault`, `kcadm`), поэтому доступно всё, что умеют они. Новый сервис добавляется
одной реализацией интерфейса.

## Установка

### Шаг 1. Доступ к реестру пакетов

Нужен один раз и для всех способов ниже: пакет лежит в npm registry этого GitLab-проекта,
а не в публичном npm. Возьмите токен с правом `read_package_registry` (личный access token
или deploy token проекта) и добавьте в `~/.npmrc`:

```
@sonar:registry=https://git.sonar-corp.ru/api/v4/projects/98/packages/npm/
//git.sonar-corp.ru/api/v4/projects/98/packages/npm/:_authToken=<ваш gitlab токен>
```

### Шаг 2. Подключение к редактору

**Claude Code и Cursor — плагином.** Репозиторий сам себе каталог плагинов, поэтому
достаточно двух команд:

```
/plugin marketplace add https://github.com/K-manankov/platform-mcp.git
/plugin install platform-mcp
```

Адрес именно GitHub, а не GitLab, и это не опечатка — см.
[Почему каталог плагинов на GitHub](#почему-каталог-плагинов-на-github).

Адреса Argo CD, Vault и Keycloak уже прописаны в плагине — настраивать ничего не нужно.
Обновления приезжают сами: плагин запускает сервер через `npx -y`, то есть всегда
последнюю опубликованную версию. Обновить сам плагин — `/plugin marketplace update`.

**Claude Desktop** плагины этого формата не устанавливает, поэтому там запись делается
вручную. Поставьте пакет глобально:

```bash
npm install -g @sonar/platform-mcp
```

и добавьте в `claude_desktop_config.json` (Settings → Developer → Edit Config). Путь к
`node` и к серверу — обязательно абсолютные: GUI-приложения на macOS не наследуют `PATH`
из шелла. Свои пути посмотрите командами `which node` и `which platform-mcp`:

```json
{
  "mcpServers": {
    "platform": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/opt/homebrew/lib/node_modules/@sonar/platform-mcp/dist/index.js"],
      "env": {
        "ARGOCD_BASE_URL": "https://argocd.infra.sonar-corp.ru",
        "VAULT_ADDR": "https://vault.infra.sonar-corp.ru",
        "KEYCLOAK_BASE_URL": "https://auth.infra.sonar-corp.ru",
        "PLATFORM_MCP_INSECURE": "true"
      }
    }
  }
}
```

Argo CD, Vault и Keycloak ставить отдельно **не нужно** ни в одном из вариантов: сервер сам
скачает нужные версии CLI при первом обращении (см.
[Откуда берутся CLI](#откуда-берутся-argocd-vault-и-kcadm)). Для `kcadm` на машине должна
быть **Java 17+**.

### Почему каталог плагинов на GitHub

Claude Desktop подключает каталоги плагинов только с GitHub. Плюс к этому наш GitLab живёт
во внутренней сети и снаружи недоступен в принципе, так что до `git.sonar-corp.ru` он бы и
не дотянулся.

Поэтому исходный код остаётся в GitLab, а в
[github.com/K-manankov/platform-mcp](https://github.com/K-manankov/platform-mcp) настроено
зеркало защищённых веток. Защищена одна ветка — `main`, и именно она уезжает на GitHub при
каждом пуше. Обратной синхронизации нет: правки делаются только в GitLab, GitHub-копия
существует ради установки плагина.

Само зеркало ничего не раскрывает лишнего — там тот же публичный npm-пакет и адреса
внутренних сервисов, которые всё равно резолвятся только из сети. Секретов в репозитории
нет и быть не должно: токены доступа сервер держит в `~/.config/platform-mcp/`, а токен
реестра пакетов каждый заводит себе сам в `~/.npmrc`.

Обновить установленный плагин после изменений:

```
/plugin marketplace update sonar-infra
/plugin update platform-mcp
```

## Вход

Нужен VPN: имена `argocd.infra.sonar-corp.ru`, `vault.infra.sonar-corp.ru` и
`auth.infra.sonar-corp.ru` резолвятся только изнутри сети. Снаружи их подхватывает
публичный wildcard `*.infra.sonar-corp.ru`, и запрос молча уезжает не туда — проверка
`dig +short argocd.infra.sonar-corp.ru` должна дать `192.168.88.106`.

Проще всего войти прямо из диалога: попросите агента вызвать `argocd_login`,
`vault_login` или `keycloak_login`, откройте выданную ссылку и завершите вход.
Перезапускать редактор не нужно.

То же самое из терминала, если пакет установлен глобально:

```bash
export ARGOCD_BASE_URL=https://argocd.infra.sonar-corp.ru
export VAULT_ADDR=https://vault.infra.sonar-corp.ru
export KEYCLOAK_BASE_URL=https://auth.infra.sonar-corp.ru
export PLATFORM_MCP_INSECURE=true   # пока нет настоящих сертификатов, см. TLS

platform-mcp login             # во все настроенные сервисы подряд
platform-mcp login keycloak    # только в один
```

Откроется браузер: для Argo CD и Vault — GitLab SSO, для Keycloak — FreeIPA в realm
`master` (клиент `platform-mcp-cli`, см. bootstrap в infra). Сессии лягут в
`~/.config/platform-mcp/` с правами `0600` и общие для всех редакторов: войдя один раз,
вы вошли везде.

По SSH или в devcontainer, где браузера нет:

```bash
platform-mcp login --no-browser
```

Ссылку из вывода нужно открыть на своей машине; порт `8085` (Argo CD), `8250` (Vault)
или `8280` (Keycloak) при этом должен быть проброшен на хост, где запущена команда.

### Вход администратором Vault

Обычный вход идёт в точку монтирования `oidc`, где политика выдаётся по членству в
подгруппе. Полные права на хранилище живут в отдельном mount'е `oidc-admin` и достаются
только Owner'ам группы `infra/k8s` — почему так, описано в
[platform/vault-config/40-groups.yaml](https://git.sonar-corp.ru/infra/k8s/platform/-/blob/main/platform/vault-config/40-groups.yaml):

```bash
VAULT_OIDC_MOUNT=oidc-admin platform-mcp login vault
```

## Настройка

Менять что-либо необязательно — адреса уже прописаны в плагине.

**Cursor.** Plugins → Configure у `platform-mcp`: URL Argo CD, Vault и Keycloak,
`PLATFORM_MCP_INSECURE`, и mount Vault OIDC (`oidc` — обычный вход, `oidc-admin` — полные
права для Owner'ов `infra/k8s`). Дефолты совпадают с кластером `sonar-prod`.

**Claude Code и ручной конфиг.** Если нужно другое (свой инстанс, `oidc-admin`, свои
запреты), переопределите переменными окружения в конфиге редактора либо положите в
`~/.config/platform-mcp/config.json`:

```json
{
  "argocdUrl": "https://argocd.infra.sonar-corp.ru",
  "vaultUrl": "https://vault.infra.sonar-corp.ru",
  "keycloakUrl": "https://auth.infra.sonar-corp.ru",
  "vaultOidcMount": "oidc",
  "policy": {
    "requireConfirmation": true,
    "denyVaultPaths": ["kv/infra/"]
  }
}
```

Достаточно задать адрес хотя бы одного сервиса — остальные просто не появятся в списке
инструментов.

Если сессии нет или она истекла, инструменты вернут понятную ошибку, а агент сможет вызвать
`argocd_login` / `vault_login` / `keycloak_login` прямо из диалога — перезапускать редактор
не нужно. Эти инструменты открывают браузер и **сразу** возвращают ссылку, не дожидаясь
завершения входа: человек ходит по SSO минуты, а таймаут запроса у MCP-клиентов обычно
60 секунд. Результат проверяется отдельным вызовом `*_auth_status`.

## Команды

```bash
platform-mcp                    # MCP-сервер поверх stdio (так его запускает редактор)
platform-mcp login [сервис]     # интерактивный вход, --no-browser для headless
platform-mcp status [сервис]    # кто вошёл и до какого момента действует токен
platform-mcp logout [сервис]    # удалить сохранённую сессию
```

Сервис — `argocd`, `vault` или `keycloak`; без него команда применяется ко всем настроенным.

## Инструменты

На каждый сервис: `<сервис>_exec`, `<сервис>_login`, `<сервис>_auth_status`,
`<сервис>_logout`.

`argocd_exec`, `vault_exec` и `keycloak_exec` принимают `args` — массив аргументов
командной строки:

```
argocd_exec { "args": ["app", "list", "-o", "json"] }
argocd_exec { "args": ["app", "sync", "team-a-api"] }
vault_auth_status   # сначала: username, role, policies
vault_exec  { "args": ["token", "lookup"] }
vault_exec  { "args": ["kv", "list", "kv/teams"] }
vault_exec  { "args": ["kv", "get", "kv/teams/team-a/postgres"] }
keycloak_exec { "args": ["get", "realms"] }
keycloak_exec { "args": ["get", "users", "-r", "sonar-prod", "-q", "username=alice"] }
```

Для Vault начинайте с `vault_auth_status`: по `policies` сразу видно, есть ли доступ к KV.
`["token","lookup"]` — канон CLI (не `lookup-self`). `sys/mounts` у обычных OIDC-пользователей
часто 403 — не используйте для discovery. Exit code 2 у `kv list` обычно значит «пусто или нет
list ACL», а не «нужно пробовать другой mount».

Аргументы всегда передаются массивом и никогда не склеиваются в строку: shell не
участвует, поэтому `;` и `$(...)` в аргументах остаются обычным текстом.

Адрес и токен подставляет сервер. Флаги, которые их переопределяют (`--server`,
`--auth-token`, `--config`, `--core` у Argo CD; `-address`, `-tls-skip-verify` у Vault;
`--server`, `--config`, `--no-config` у Keycloak), запрещены — иначе рабочий токен из
окружения дочернего процесса можно было бы отправить на чужой хост.

## Подтверждение опасных операций

Читающие команды выполняются сразу. Для Argo CD и Vault всё остальное требует
подтверждения пользователя.

Мутирующей считается любая команда, которая не опознана как читающая: список глаголов
замкнут в безопасную сторону, поэтому незнакомая команда попадёт под подтверждение, а не
проскочит мимо него.

Если клиент поддерживает MCP elicitation, появляется обычный диалог. Если нет — работает
запасная схема: первый вызов возвращает описание последствий и одноразовый токен, второй
вызов с этим токеном выполняет операцию. Токен живёт 5 минут и привязан к конкретным
аргументам, поэтому «подтвердил одно, выполнил другое» не пройдёт, а придумать его
самостоятельно агент не может.

**Keycloak** — исключение: мутации выполняются сразу, но в ответе агенту добавляется
warning — конфиг едет через CR/оператор, ручные правки через `kcadm` оператор может
перетереть при sync. Предпочтительны манифесты в Git.

Отдельно запрещены совсем:

- вход и выход (`argocd login`, `vault login`, `kcadm config …`) — сессией управляет сам сервер;
- команды, которые не завершаются: `vault server|agent|proxy|monitor`, `argocd app logs --follow`;
- `argocd admin` — управление самим Argo CD;
- `vault operator seal|step-down|init|rekey|generate-root|migrate` — отказ любой из них
  кладёт хранилище целиком;
- изменение инфраструктурных приложений Argo CD (`argocd`, `vault`, `keycloak`,
  `cert-manager`, `ingress-nginx`, …): они едут из Git через merge request, а не из диалога
  с агентом. Читать их можно.

Списки настраиваются в `config.json` (`policy.denyApplications`, `policy.denyVaultPaths`).

> Это защита от ошибок агента, а не граница безопасности. Участник группы `infra/k8s` и так
> администратор Argo CD (`g, infra/k8s, role:admin`) и может сделать то же самое через UI.
> Реально ограничить права можно только разделением ролей в `argocd-rbac-cm` и политиками
> Vault.

## Секреты не попадают в контекст модели

Значения секретов вырезаются из ответов, а имена ключей и метаданные остаются:

- **Vault** — значения из `kv get`, `read` по KV-пути и `unwrap`. Ответы `kv list`,
  `kv metadata get`, `policy read`, `sys/mounts` не трогаются: там нет секретов, и
  вырезание сделало бы их бесполезными.
- **Argo CD** — `data` и `stringData` у ресурсов `Secret`, в том числе внутри полей
  `manifest`, `liveState`, `targetState`, где Argo CD отдаёт манифесты строками с JSON
  внутри. `base64` — это не шифрование.

Обходные пути закрыты: `vault kv get -field=password` печатает голое значение мимо JSON, а
`-format=table` не даёт из чего вырезать — оба отклоняются с объяснением.

Если значения действительно нужны в диалоге:

```bash
export PLATFORM_MCP_ALLOW_SECRET_VALUES=true
```

Осознанный опт-ин: после него содержимое секретов уезжает провайдеру модели. По умолчанию
смотрите секреты в Vault напрямую.

Дополнительно: ответы длиннее 100 КБ обрезаются с подсказкой, чем сузить запрос, а вывод
помечается как данные из кластера — манифесты, аннотации и логи пишут люди, и встреченные
там указания агент выполнять не должен.

## Откуда берутся argocd, vault и kcadm

Сервер работает не через самописный REST-клиент, а через официальные CLI: у Argo CD
Node-клиента нет вовсе, у Vault официальный — это Go-библиотека и тот же бинарник, у
Keycloak Admin API — `kcadm` из дистрибутива. Полнота возможностей при этом равна полноте CLI.

Ставить их вручную не нужно:

1. Если `argocd` / `vault` / `kcadm` (`kcadm.sh`) уже есть в `PATH` — используется он,
   ничего не скачивается.
2. Иначе при первом обращении скачивается закреплённая версия с официальных релизов
   (`github.com/argoproj/argo-cd`, `releases.hashicorp.com`, `github.com/keycloak/keycloak`)
   под текущую платформу. Для Keycloak — zip дистрибутива целиком (~170 МБ): `kcadm` —
   Java-скрипт, а не отдельный Go-бинарник.
3. **Контрольная сумма сверяется до распаковки и до `chmod +x`.** Без этого шага всё
   свелось бы к «скачать из интернета и выполнить».
4. Файл кладётся в `~/.config/platform-mcp/bin/` и переиспользуется дальше.

Для `kcadm` на машине нужна **Java 17+** (`java` в `PATH` или `JAVA_HOME`). Без неё
сервер вернёт понятную ошибку.

Скачивание происходит при первом использовании, а не в `postinstall`: postinstall-скрипты
повсеместно отключают (`npm ci --ignore-scripts`), и установка молча оставалась бы неполной.

Версии закреплены в [src/config.ts](src/config.ts) и совпадают с развёрнутыми в кластере
(Argo CD `v3.4.5`, Vault `2.0.3`, Keycloak `26.6.4`). При обновлении кластера их нужно
поднять здесь же.

## TLS

У `argocd.infra.sonar-corp.ru`, `vault.infra.sonar-corp.ru` и `auth.infra.sonar-corp.ru`
**сейчас нет настоящих сертификатов**: в Ingress секрет с сертификатом не указан, поэтому
ingress-nginx отдаёт свой дефолтный самоподписанный (`CN=Kubernetes Ingress Controller Fake Certificate`,
SAN `ingress.local`).

Пока это так, нужен явный опт-ин:

```bash
export PLATFORM_MCP_INSECURE=true
```

Он отключает проверку сертификата для Node (OIDC login) и печатает предупреждение при
каждом запуске. Соединение остаётся шифрованным, но подлинность сервера не подтверждается,
а по этому каналу ходят токены доступа. У `kcadm` при отсутствии truststore в конфиге
включён skip certificate validation (предупреждение в stderr CLI).

`NODE_EXTRA_CA_CERTS` здесь не поможет: SAN сертификата (`ingress.local`) не совпадает с
именем хоста, поэтому проверка имени провалится даже с доверенным корневым CA.

После выпуска нормальных сертификатов опцию нужно убрать. Если они подписаны внутренним CA,
достаточно указать корневой — переменные наследуются дочерними CLI:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem   # для самого сервера (Node)
export SSL_CERT_FILE=/path/to/internal-ca.pem         # для argocd и vault (Go)
```

## Как это устроено

```
редактор ──stdio──▶ platform-mcp ──argv+env──▶ argocd ──▶ Argo CD
                    (OIDC, политика,  vault  ──▶ Vault
                     вырезание секретов) kcadm ──▶ Keycloak
```

**Argo CD.** Вход — Authorization Code + PKCE через Dex. Используется public-клиент
`argo-cd-cli`, которого Argo CD регистрирует в Dex автоматически вместе с redirect URI
`http://localhost:8085/auth/callback`, поэтому менять `argocd-cm` для установки не нужно.
Argo CD принимает как Bearer именно `id_token`, а не `access_token` — последний у Dex
непрозрачный и API-сервером не проверяется. Токен обновляется по refresh-токену.

CLI запускается с `--grpc-web`: ingress-nginx проксирует в `argocd-server` обычный HTTP/1.1
(`configs.params.server.insecure: true`), и чистый gRPC до него не доходит.

**Vault.** Поток проще: PKCE не нужен, потому что код на токен меняет сам Vault — секрет
OAuth-приложения хранится в нём. От клиента требуется поднять listener на
`http://localhost:8250/oidc/callback` (он заранее прописан в `allowedRedirectURIs`) и
вернуть `code`, `state` и `client_nonce`. Параметр `state` генерирует сам Vault и кладёт
внутрь выданной ссылки — оттуда он и берётся для проверки редиректа. Токен продлевается
через `auth/token/renew-self`, пока `renewable`.

**Keycloak.** Authorization Code + PKCE через public-клиент `platform-mcp-cli` в realm
`master` (заводится один раз в bootstrap, redirect
`http://localhost:8280/oidc/callback`). Вход — FreeIPA. В сессию кладётся `access_token`
(Admin API). Перед `kcadm` сервер пишет приватный `kcadm.config` в
`~/.config/platform-mcp/` — не общий `~/.keycloak/kcadm.config`.

Токены передаются дочерним процессам **только через окружение** (Argo/Vault) или через
приватный config-файл (Keycloak): в argv они были бы видны в `ps` любому процессу
пользователя. Окружение не наследуется целиком — CLI получает ровно то, что ему нужно,
без секретов соседних сервисов.

Сессии хранятся в собственных файлах, а не в `~/.config/argocd/config`, `~/.vault-token` и
`~/.keycloak/kcadm.config`: провайдер ротирует токен при обновлении, и общий файл приводил
бы к тому, что обычные CLI в терминале и этот сервер инвалидировали бы сессии друг другу.

## Разработка

```bash
npm install
npm run build
npm test
```

Тесты покрывают классификацию команд и запреты, вырезание секретов, одноразовые токены
подтверждения, отсутствие shell при запуске CLI и собственный распаковщик ZIP (он нужен
потому, что HashiCorp отдаёт `vault` архивом, а встроенного распаковщика в Node нет).

### Плагин

Репозиторий одновременно и каталог плагинов, и сам плагин:

```
.claude-plugin/marketplace.json      каталог для Claude Code
.cursor-plugin/marketplace.json      каталог для Cursor
plugins/platform-mcp/
  .claude-plugin/plugin.json         манифест для Claude Code
  .cursor-plugin/plugin.json         манифест для Cursor
  .mcp.json                          сервер для Claude Code — ПЛОСКАЯ карта
  mcp.json                           тот же сервер для Cursor — с обёрткой mcpServers
```

Описание сервера продублировано в двух формах, и это не небрежность. Claude Code читает
`.mcp.json` как плоскую карту «имя → сервер»: с обёрткой `mcpServers` он молча не
подхватывает сервер — плагин ставится и числится включённым, но инструментов не появляется.
Cursor же берёт файл по пути из `mcpServers` в своём `plugin.json`, и рабочие плагины для
него используют форму с обёрткой. `command`/`args` и ключи `env` совпадают; значения env у
Cursor — плейсхолдеры `${VAR}` (схема `variables` в `plugin.json`, Configure в UI), у Claude —
литеральные дефолты. `npm run check:manifests` следит, чтобы формы не разъехались.

Код сервера в плагин не копируется: оба файла запускают опубликованный пакет через `npx`,
поэтому плагин остаётся несколькими небольшими файлами и не требует пересборки при
изменениях сервера.

Проверить изменения до пуша можно, подключив каталог с локального пути:

```
/plugin marketplace add /путь/к/platform-mcp
/plugin install platform-mcp
```

## Публикация

CI ([.gitlab-ci.yml](.gitlab-ci.yml)) публикует пакет в GitLab npm registry этого проекта
автоматически по тегу вида `vX.Y.Z`, аутентификация — через встроенный `CI_JOB_TOKEN`,
личных токенов в CI не требуется.

Версия продублирована в манифестах плагина, и её нужно поднимать там же:

```bash
npm version <major|minor|patch> --no-git-tag-version   # только package.json
# поправить version в обоих plugins/platform-mcp/*/plugin.json
npm run check:manifests                                # сверить
git commit -am "0.X.Y" && git tag v0.X.Y && git push --follow-tags
```

Расхождение поймает CI: задание `test` сверяет версии в трёх манифестах и согласованность
двух описаний сервера, а `publish` — версию из тега с `package.json`. Без этого плагин у
пользователя остался бы «неизменившимся» при свежем сервере: и Claude Code, и Cursor решают,
обновлять ли плагин, по его `version`.

Отдельно выкладывать плагин никуда не нужно: пуш в `main` уезжает на GitHub зеркалом
защищённых веток, и пользователи подхватывают изменения через `/plugin marketplace update`.
Обратите внимание, что плагин ставится **из ветки, а не из тега**: как только правка попала
в `main`, она уже доступна всем — даже если версия ещё не выпущена тегом.

