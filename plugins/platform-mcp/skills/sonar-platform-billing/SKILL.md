---
name: sonar-platform-billing
description: How billing works on sonar-prod — OpenMeter (usage metering and prepaid credit grants), billing-adapter (YooKassa payments), the openmeter-gateway auth proxy in front of an API that has no authentication of its own, and the catalog-as-code repo infra/k8s/openmeter-resources. Use when the user wants to send usage events, read a customer's balance or entitlements, add or change a meter, feature or plan (package), wire an app into OpenMeter, debug 401/403 from the gateway or a pod that cannot reach openmeter-api, issue or inspect credit grants, or asks about YooKassa checkout, credits, packages, subjects, or anything under openmeter.infra.sonar-corp.ru. Never tell an app to call openmeter-api directly — NetworkPolicy blocks it and the API is unauthenticated.
---

# Биллинг sonar-prod: подключить приложение к OpenMeter

Этот скилл — для разработчика, который подключает **своё** приложение к
платформенному биллингу, а не для тех, кто держит сам стенд OpenMeter. Три шага
ниже покрывают почти все задачи; про устройство стенда изнутри — в конце, как
справочный контекст.

## Подключить приложение

Три шага, все — в репозитории самого приложения; MR в платформу не нужен.

1. **`KeycloakClient` в `deploy/overlays/<env>/`** (не в `base/`: realm у контуров
   разный). `serviceAccountsEnabled: true`, `publicClient: false`,
   `standardFlowEnabled: false`; `clusterRealmRef` — `sonar-prod` или `sonar-dev`.
   Секрет генерирует оператор и кладёт в Secret рядом (ключи `client-id` /
   `client-secret`) — в Vault за ним ходить не надо. **Заведите отдельный клиент
   под OpenMeter** — не переиспользуйте тот, что у приложения уже есть под
   другую задачу (SSO, org-sync, CI). Если это не так, доступ к биллингу
   получает всё, что знает тот секрет; отозвать его нельзя, не сломав ту
   задачу; и по списку клиентов не видно, кто ходит в OpenMeter.
2. **Склейка ключа в `env`** пода. Порядок важен: `$(VAR)` подставляет только
   объявленные выше переменные.
   ```yaml
   - name: OPENMETER_CLIENT_ID
     valueFrom: {secretKeyRef: {name: openmeter-client-oidc-test, key: client-id}}
   - name: OPENMETER_CLIENT_SECRET
     valueFrom: {secretKeyRef: {name: openmeter-client-oidc-test, key: client-secret}}
   - name: OPENMETER_API_KEY
     value: "$(OPENMETER_CLIENT_ID):$(OPENMETER_CLIENT_SECRET)"
   ```
   Имя Secret'а пишется литерально, с суффиксом окружения: `nameSuffix` оверлея
   ссылки внутрь `secretKeyRef` не переписывает (та же ловушка, что с
   `ExternalSecret` в скилле secrets).
3. **`OPENMETER_API_ENDPOINT`** — адрес шлюза своего контура, **не** `openmeter-api`
   напрямую (к нему нет пути — см. ниже):
   ```
   http://openmeter-gateway.openmeter.svc.cluster.local        # прод
   http://openmeter-gateway-test.openmeter.svc.cluster.local   # тест
   https://openmeter.infra.sonar-corp.ru/api/...               # снаружи, из офиса/VPN
   ```

Всё: `ingest` и `read` работают сразу, как только клиент завёлся — MR в
платформу для этого не нужен (см. классы прав ниже). Проверить, что клиент
завёлся: `keycloak_exec { "args": ["get", "clients", "-r", "sonar-prod", "-q", "clientId=<id>"] }`.

**Никогда не предлагать `openmeter-api.openmeter.svc` как адрес для
приложения** — запрос повиснет в таймауте: NetworkPolicy пускает к API только
шлюз, `billing-adapter` и `openmeter-customer-sync`, никакого другого клиента.

## Ключ = секрет клиента Keycloak

Формат — не JWT, а склейка, которую понимает шлюз:

```
Authorization: Bearer <client_id>:<client_secret>
```

Шлюз проверяет пару у Keycloak (`client_credentials` в realm'е контура: прод —
`sonar-prod`, тест — `sonar-dev`, поэтому ключ одного контура другой не открывает)
и кэширует ответ: 5 минут на успех, 30 секунд на отказ. Если Keycloak недоступен,
уже проверенный ключ продолжает работать из кэша, новый получит 500. Отзыв ключа
(отключить клиента или сменить секрет) действует с задержкой до пяти минут.

Почему не JWT: LiteLLM и скрипты `sonar-compute` умеют только статичную строку в
заголовке и не получают токен сами. Не предлагать переход на `client_credentials`
в приложении как «правильный» вариант — он упирается в код LiteLLM.

## Классы прав (`authz.map`) — что доступно вашему клиенту

| Класс | Запрос | Кому выдан |
|---|---|---|
| `ingest` | `POST /api/v1/events` | **любой** клиент, прошедший `client_credentials` |
| `read` | `GET` планов, клиентов, entitlement'ов и грантов | он же |
| `catalog` | `GET\|POST\|PUT` на `/meters`, `/features`, `/plans` и **любые** их подпути (`publish`, `next`, `archive`) | Job каталога (`openmeter-catalog`) |
| `other` | всё остальное: выдача грантов, профили биллинга, `DELETE` | **в проде никому** |

`ingest` и `read` выданы шаблоном `"~^.+:(ingest|read)$"`, то есть **любому**
клиенту вашего приложения — это и есть то, что делает подключение
самообслуживаемым: отправка событий и чтение баланса/entitlement'ов не требуют
MR в платформу, `authz.map` для этого не правят.

Коды ответа: **401** — ключа нет или он неверный; **403** — ключ верный, но класс
клиенту не выдан. 403 приходит до похода в Keycloak, поэтому «403 на POST /meters
ключом приложения» — это не сломанный ключ, а отсутствие права (класс `catalog`
или `other`, они вашему клиенту не положены).

Если 401 при верном ключе — проверить, что у клиента включён
`serviceAccountsEnabled` (публичные клиенты и конфиденциальные без него получают
401 `unauthorized_client` и до проверки права не доходят).

## Тест: пробовать без ключей

На тестовом шлюзе запрос **без** заголовка `Authorization` считается клиентом
`anonymous`, которому на тесте выданы все классы. Ключ, который передан, но
неверен (или мусор в заголовке), анонимом не становится и получает 401 — то
есть флоу авторизации проверяется на тесте ровно как в проде.

Рабочий приём: попробовать конфигурацию руками на
`https://openmeter-test.infra.sonar-corp.ru/api/...` без всяких ключей из
офиса/VPN, а потом закоммитить то же самое в приложение и в каталог (если
нужны новые метр/фича/план — см. ниже).

## Если приложению нужен новый метр, фича или план

Метр, фича и план в OpenMeter — общий ресурс, не собственность одного
приложения: **один метр рассчитан на переиспользование разными приложениями**,
фича собирается поверх метра, план ссылается на фичу. Поэтому, в отличие от
обычного правила «всё для приложения — в репозитории приложения», каталог
живёт одним общим репозиторием `infra/k8s/openmeter-resources`
(`base/catalog/{meters,features,plans}/`, JSON), а не в вашем.

Перед тем как заводить свой объект — посмотреть, нет ли уже подходящего, и не
плодить дубль. Переименовать или переделать существующий метр/фичу «под себя»
нельзя тем более: они, возможно, уже чьи-то, и в OpenMeter метры и фичи после
создания **неизменяемы**. Если объект уже используется чужим приложением,
правка в нём уедет и туда — при сомнении завести новый объект рядом, а не
переделывать чужой.

Применяет каталог Job (`sync.py`, PostSync-хук Argo CD) — **без расписания**,
только после синка приложения в Git: мерж в `main` уходит на тестовый OpenMeter,
мерж `main` → `prod` — на боевой. Что он делает:

- нет в OpenMeter — создаёт (план ещё и публикует);
- **план изменился** — выкатывает новой версией (`next` → правка черновика →
  `publish`); прошлая версия архивируется сама, уже выданные гранты не трогаются;
- **метр или фича изменились** — не меняет (неизменяемы), пишет расхождение и
  падает с кодом 1;
- **файл убрали из Git** — ничего не делает; удаления Job не делает намеренно.

Новый файл каталога **обязательно вписать в `base/kustomization.yaml`** —
kustomize не понимает масок, забытый файл Job просто не увидит; `ci/check.py`
репозитория на это падает.

Посмотреть результат: `kubectl -n openmeter logs job/openmeter-catalog-sync-test`
или статус PostSync-хука (`argocd_exec { "args": ["app", "get", "openmeter-catalog-test"] }`).

### Ловушки формата каталога

- **`valueProperty` и `groupBy` метра — JSONPath от поля `data` события, не от
  корня**: `$.cost`, а не `$.data.cost`. С неправильным путём события
  принимаются (`204`), но молча отваливаются на валидации внутри пайплайна —
  видно только в `GET /api/v1/events?subject=...` или в логах `sink-worker`.
- **План** — ровно одна фаза и один `flat_fee` rate card, иначе billing-adapter
  откажет в checkout. Цена — `rateCards[0].price.amount` в `currency` плана.
- **`metadata.package_mode`**: `subscription` (пакет со сроком, повторно купить
  нельзя, пока грант не истёк) или `topup` (докупается в любой момент, гранты
  складываются). Сумма и срок — либо через `entitlementTemplate`
  (`issueAfterReset` / `usagePeriod`), либо через `metadata.credits` /
  `metadata.validity`. Бессрочный пакет возможен только во второй форме.
- **`featureKey` rate card'а** должен указывать на фичу, по которой приложение
  ищет баланс (`OPENMETER_FEATURE_KEY`, у sonar-compute — `litellm_credits`).
  Грант на другую фичу баланс приложения не увидит, даже если она сидит на том
  же метре.

Права на **сам** класс `catalog` в шлюзе (кто может править каталог) — это уже
не в вашем репозитории, а в общем `infra/k8s/platform`; поименован только Job
каталога. Если приложению зачем-то понадобится сам класс `catalog` (а не
только правка JSON, которую катит Job) — это отдельный разговор и отдельный MR
в платформу.

## Деньги и гранты

Деньги принимает не OpenMeter, а `billing-adapter` через ЮKassa. Подписок и
инвойсов нет с 2026-09-18: планы — только каталог пакетов.

```
POST /billing/checkout → оплата в ЮKassa → payment.succeeded →
  billing-adapter выдаёт ГРАНТ кредитов на entitlement клиента → метр списывает
```

`/billing/*` висит на том же хосте, что и API (`openmeter.infra.sonar-corp.ru`).
Пакет заканчивается сам — по кредитам или по сроку, продления нет.

Гранты вручную (компенсация, разбор инцидента) — это класс `other`, в проде он
не выдан никому: только администратор через port-forward (см. ниже). Не
предлагать выдать грант ключом приложения — это 403.

## Ограничения стенда — говорить о них честно

- **Postgres и ClickHouse OpenMeter стоят на `local-path` без паролей и без
  бэкапов**, всё на одной ноде. Потеря ноды = потеря выданных грантов
  (оплаченных кредитов) и всей истории потребления.
- **Каталог — единственное, что переживает потерю базы** (JSON в
  `openmeter-resources`). Customer'ы заводятся заново при входе, гранты — нет.
- **Ключ шлюза различает приложения, но не пользователей**: `subject` в
  событии задаёт вызывающий. Поэтому ключ выдаётся только серверным
  бэкендам, никогда браузеру или мобильному клиенту. Пользовательские запросы
  (баланс, список пакетов) идут через сервис, который проверяет токен
  пользователя и берёт `subject` из него.

## Как это устроено внутри (справочно)

Стенд живёт в namespace `openmeter`, два контура в одном namespace (прод и
тест различаются суффиксом `-test`, не namespace'ом — в OpenMeter «namespace»
это арендатор, один на процесс, поэтому тестовый контур — отдельный комплект
подов).

| Компонент | Что делает | Application (прод / тест) |
|---|---|---|
| OpenMeter (`api`, `sink-worker`, `balance-worker`) | события → Kafka → ClickHouse, метры, entitlement'ы, гранты | `openmeter` / `openmeter-test` |
| `openmeter-gateway` | nginx с авторизацией перед `openmeter-api` | `openmeter-gateway` / `openmeter-gateway-test` |
| `billing-adapter` | checkout ЮKassa → грант кредитов | `billing-adapter` / `billing-adapter-test` |
| `openmeter-customer-sync` | заводит customer'а при первом входе в Keycloak | `openmeter-customer-sync` |
| каталог (метры, фичи, планы) + Job | применяет JSON из Git в OpenMeter | `openmeter-catalog` / `openmeter-catalog-test` |
| NetworkPolicy | закрывает прямой путь к API и базам | `openmeter-netpol` |

Манифесты — в `infra/k8s/platform` (`platform/openmeter*`, `platform/billing-adapter`),
кроме каталога — он в `infra/k8s/openmeter-resources` (см. выше почему).

**В открытой версии OpenMeter аутентификации нет вовсе** — кто дотянулся до
порта, шлёт события за кого угодно и выдаёт себе кредиты. Поэтому прямой путь
закрыт NetworkPolicy (`platform/openmeter-netpol/`): Postgres и ClickHouse —
только поды самого OpenMeter (паролей у этих баз нет, политика — единственная
граница); Kafka закрыта значениями чарта (`networkPolicy.allowExternal: false`).

Админский доступ ко всему, что шлюз не пропускает (гранты, профили биллинга,
удаление, разбор состояния):

```bash
kubectl -n openmeter port-forward svc/openmeter-api 18080:80      # прод
kubectl -n openmeter port-forward svc/openmeter-test-api 18081:80 # тест
```

Port-forward идёт с ноды и под NetworkPolicy не подпадает — это ожидаемая
админская дверь, а не дыра в политике. Аутентификации за ней нет вообще, так
что это доступ уровня «кто имеет `kubectl` в кластер».

От чарта OpenMeter остались два Deployment'а с нулём подов и три CronJob'а с
расписанием «31 февраля» (биллинг на подписках) — намеренно, не забытый мусор:
`enabled`-флагов у них в чарте нет.
