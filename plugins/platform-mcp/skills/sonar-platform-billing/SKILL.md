---
name: sonar-platform-billing
description: How billing works on sonar-prod — OpenMeter (usage metering and prepaid credit grants), billing-adapter (YooKassa payments), the openmeter-gateway auth proxy in front of an API that has no authentication of its own, and the catalog-as-code repo infra/k8s/openmeter-resources. Use when the user wants to send usage events, read a customer's balance or entitlements, add or change a meter, feature or plan (package), wire an app into OpenMeter, debug 401/403 from the gateway or a pod that cannot reach openmeter-api, issue or inspect credit grants, or asks about YooKassa checkout, credits, packages, subjects, or anything under openmeter.infra.sonar-corp.ru. Never tell an app to call openmeter-api directly — NetworkPolicy blocks it and the API is unauthenticated.
---

# Биллинг sonar-prod: OpenMeter, шлюз, каталог

Весь стенд живёт в namespace `openmeter`, **два контура в одном namespace**
(прод и тест различаются суффиксом `-test` и меткой `app.kubernetes.io/instance`,
а не namespace'ом). В OpenMeter «namespace» — это арендатор, один на процесс
(`config.namespace.default`), поэтому тестовый контур — отдельный комплект подов,
а не второй namespace внутри одного OpenMeter.

| Компонент | Что делает | Application (прод / тест) |
|---|---|---|
| OpenMeter (`api`, `sink-worker`, `balance-worker`) | события → Kafka → ClickHouse, метры, entitlement'ы, гранты | `openmeter` / `openmeter-test` |
| `openmeter-gateway` | nginx с авторизацией перед `openmeter-api` | `openmeter-gateway` / `openmeter-gateway-test` |
| `billing-adapter` | checkout ЮKassa → грант кредитов | `billing-adapter` / `billing-adapter-test` |
| `openmeter-customer-sync` | заводит customer'а при первом входе в Keycloak | `openmeter-customer-sync` |
| каталог (метры, фичи, планы) + Job | применяет JSON из Git в OpenMeter | `openmeter-catalog` / `openmeter-catalog-test` |
| NetworkPolicy | закрывает прямой путь к API и базам | `openmeter-netpol` |

Манифесты — в `infra/k8s/platform` (`platform/openmeter*`, `platform/billing-adapter`),
кроме каталога: он в отдельном репозитории `infra/k8s/openmeter-resources`, чтобы
разработчикам биллинга хватало доступа туда, а не ко всей платформе.

## Ресурсы OpenMeter — общие, а не «чьи-то»

Это главное, что определяет, где что правится. Метр, фича и план — не
принадлежность одного приложения: **один метр рассчитан на переиспользование
разными приложениями**, фича собирается поверх метра, план ссылается на фичу.
Поэтому каталог не разносится по репозиториям приложений, а лежит одним общим
репозиторием, и права на общий OpenMeter приложение себе не выдаёт.

Обычное правило «всё, что касается приложения, правится в репозитории
приложения» здесь **не действует** — и это не исключение ради удобства, а
следствие переиспользования. Что где правится:

| Что | Где |
|---|---|
| каталог: метры, фичи, планы | `infra/k8s/openmeter-resources` (общий) |
| права клиента в шлюзе (`authz.map`) | `infra/k8s/platform` (общий) |
| `KeycloakClient` приложения, адрес шлюза, склейка ключа в `env` | `deploy/` репозитория приложения |

Из этого следует и практика: добавляя метр или фичу, сначала посмотреть, нет ли
уже подходящей, и не заводить дубль под своё приложение. Переименовать или
переделать существующий метр «под себя» нельзя тем более — он, возможно, уже
чей-то, а в OpenMeter метры и фичи после создания неизменяемы (см. ниже).

## Главное: в `openmeter-api` напрямую не ходят

**В открытой версии OpenMeter аутентификации нет вовсе.** Кто дотянулся до порта —
шлёт события за кого угодно, читает чужое потребление и выдаёт себе кредиты.
Поэтому прямой путь закрыт NetworkPolicy (`platform/openmeter-netpol/`): к
`openmeter-api` пускают только шлюз своего контура, `billing-adapter` и
`openmeter-customer-sync`; Postgres и ClickHouse — только поды самого OpenMeter
(паролей у этих баз нет, политика — единственная граница); Kafka закрыта
значениями чарта (`networkPolicy.allowExternal: false`), а не отдельной политикой —
политики складываются, и вторая рядом с чартовой «разрешить всем» ничего бы не дала.

Приложение ходит на шлюз:

```
http://openmeter-gateway.openmeter.svc.cluster.local        # прод
http://openmeter-gateway-test.openmeter.svc.cluster.local   # тест
https://openmeter.infra.sonar-corp.ru/api/...               # снаружи, из офиса/VPN
```

Никогда не предлагать `openmeter-api.openmeter.svc` как адрес для приложения —
запрос повиснет в таймауте, и это не сеть сломалась, а ровно то, что задумано.

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

## Классы прав (`authz.map`)

Каждый запрос относится к классу (`map $om_scope`, `platform/openmeter-gateway/base/default.conf`),
а `overlays/<env>/authz.map` говорит, какому `client_id` какие классы можно:

| Класс | Запрос | Кому выдан |
|---|---|---|
| `ingest` | `POST /api/v1/events` | бэкенд приложения (`sonar-compute-openmeter`) |
| `read` | `GET` планов, клиентов, entitlement'ов и грантов | он же |
| `catalog` | `GET\|POST\|PUT` на `/meters`, `/features`, `/plans` и подпути (`publish`, `next`) | Job каталога (`openmeter-catalog`) |
| `other` | всё остальное: выдача грантов, профили биллинга, `DELETE` | **в проде никому** |

Коды ответа: **401** — ключа нет или он неверный; **403** — ключ верный, но класс
клиенту не выдан. 403 приходит до похода в Keycloak, поэтому «403 на POST /meters
ключом приложения» — это не сломанный ключ, а отсутствие права.

## Тест: авторизация необязательна

На тестовом шлюзе запрос **без** заголовка `Authorization` считается клиентом
`anonymous`, которому в `overlays/test/authz.map` выданы все классы. Ключ, который
передан, но неверен (или мусор в заголовке), анонимом не становится и получает 401 —
то есть флоу авторизации проверяется на тесте ровно как в проде. В Keycloak за
анонима шлюз не ходит.

Отсюда рабочий приём: разработчик из офиса/VPN пробует конфигурацию руками на
`https://openmeter-test.infra.sonar-corp.ru/api/...` без всяких ключей, а потом
кладёт то же самое JSON'ом в Git. Ручные правки на тесте Job не откатывает (он
ничего не удаляет), но и в прод они сами не попадут.

## Подключить приложение к OpenMeter

Четыре шага, три из них — в репозитории самого проекта:

1. **`KeycloakClient` в `deploy/overlays/<env>/`** (не в `base/`: realm у контуров
   разный). `serviceAccountsEnabled: true`, `publicClient: false`,
   `standardFlowEnabled: false`; `clusterRealmRef` — `sonar-prod` или `sonar-dev`.
   Секрет генерирует оператор и кладёт в Secret рядом (ключи `client-id` /
   `client-secret`) — в Vault за ним ходить не надо.
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
3. **`OPENMETER_API_ENDPOINT`** — адрес шлюза своего контура (см. выше).
4. **MR в `infra/k8s/platform`**: строки `"<client_id>:ingest"` и `"<client_id>:read"`
   в `platform/openmeter-gateway/overlays/{test,prod}/authz.map`. Без него шлюз
   ответит приложению 403.

Шаг 4 — единственный вне репозитория приложения, и убирать его «по политике»
не нужно: OpenMeter общий (см. выше), ключ с классом `ingest` шлёт события за
любой `subject`, а с `catalog` — правит чужие метры и планы. Поэтому права
выдаются явным MR, а не тем, что приложение объявило себе клиента с нужным
именем.

Проверить, что клиент завёлся: `keycloak_exec { "args": ["get", "clients", "-r", "sonar-prod", "-q", "clientId=<id>"] }`.

## Каталог: метры, фичи, планы — как код

Репозиторий `infra/k8s/openmeter-resources`, JSON в `base/catalog/{meters,features,plans}/`.
Применяет Job (`sync.py`, PostSync-хук Argo CD), он ходит в шлюз клиентом
`openmeter-catalog`. **Расписания нет** — Job срабатывает только после синка
приложения, то есть после изменения в Git.

| Событие | Куда уходит |
|---|---|
| мерж MR в `main` | тестовый OpenMeter (`openmeter-catalog-test`) |
| мерж `main` → `prod` | боевой (`openmeter-catalog`) |

Что Job делает и чего не делает:

- нет в OpenMeter — создаёт (план ещё и публикует);
- **план изменился** — выкатывает новой версией (`next` → правка черновика →
  `publish`); прошлая версия архивируется сама, уже выданные гранты не трогаются;
- **метр или фича изменились** — не меняет: в OpenMeter они неизменяемы после
  создания. Пишет расхождение и завершается с кодом 1 (провалившийся синк);
- **файл убрали из Git** — ничего не делает. Удаления и отключения в Job нет
  намеренно; убрать метр, фичу или план — вручную через port-forward.

Новый файл каталога **обязательно вписать в `base/kustomization.yaml`**: kustomize
не понимает маски, забытый файл Job просто не увидит. Пайплайн репозитория
(`ci/check.py`) на это падает.

Каталог общий, поэтому правка здесь — это правка для всех: изменение плана,
которым уже пользуется чужое приложение, уедет и ему тоже. Прежде чем менять
существующий объект, посмотреть, кто на него ссылается (фича — на метр, планы —
на фичу), и при сомнении завести новый объект рядом, а не переделывать чужой.
Тестовый контур для того и открыт без ключа, чтобы проверить до MR.

Посмотреть результат: `kubectl -n openmeter logs job/openmeter-catalog-sync-test`
или статус PostSync-хука в Argo CD (`argocd_exec { "args": ["app", "get", "openmeter-catalog-test"] }`).

### Ловушки формата

- **`valueProperty` и `groupBy` метра — JSONPath от поля `data` события, не от
  корня**: `$.cost`, а не `$.data.cost`. С неправильным путём события принимаются
  (`204`), но молча отваливаются на валидации внутри пайплайна — видно только в
  `GET /api/v1/events?subject=...` или в логах `sink-worker`.
- **План** — ровно одна фаза и один `flat_fee` rate card, иначе billing-adapter
  откажет в checkout. Цена — `rateCards[0].price.amount` в `currency` плана.
- **`metadata.package_mode`**: `subscription` (пакет со сроком, повторно купить
  нельзя, пока грант не истёк) или `topup` (докупается в любой момент, гранты
  складываются). Сумма и срок — либо через `entitlementTemplate`
  (`issueAfterReset` / `usagePeriod`), либо через `metadata.credits` /
  `metadata.validity`. Бессрочный пакет возможен только во второй форме.
- **`featureKey` rate card'а** должен указывать на фичу, по которой приложение ищет
  баланс (`OPENMETER_FEATURE_KEY`, у sonar-compute — `litellm_credits`). Грант на
  другую фичу баланс приложения не увидит, даже если она сидит на том же метре.

## Деньги и гранты

Деньги принимает не OpenMeter, а `billing-adapter` через ЮKassa. Подписок и
инвойсов нет с 2026-09-18: планы — только каталог пакетов.

```
POST /billing/checkout → оплата в ЮKassa → payment.succeeded →
  billing-adapter выдаёт ГРАНТ кредитов на entitlement клиента → метр списывает
```

`/billing/*` висит на том же хосте, что и API (`openmeter.infra.sonar-corp.ru`),
отдельным Ingress-объектом; TLS хоста объявляет Ingress шлюза. Пакет заканчивается
сам — по кредитам или по сроку, продления нет.

Гранты вручную (компенсация, разбор инцидента) — это класс `other`, в проде он не
выдан никому: только администратор через port-forward. Не предлагать выдать грант
ключом приложения, это 403.

## Админский доступ к прод-API

Всё, что шлюз не пропускает (гранты, профили биллинга, удаление, разбор состояния):

```bash
kubectl -n openmeter port-forward svc/openmeter-api 18080:80      # прод
kubectl -n openmeter port-forward svc/openmeter-test-api 18081:80 # тест
```

Port-forward идёт с ноды и под NetworkPolicy не подпадает — это ожидаемая
админская дверь, а не дыра в политике. Аутентификации за ней нет вообще, так что
это доступ уровня «кто имеет `kubectl` в кластер».

## Ограничения стенда — говорить о них честно

- **Postgres и ClickHouse OpenMeter стоят на `local-path` без паролей и без
  бэкапов**, всё на одной ноде (`k8s-worker-01`). Потеря ноды = потеря выданных
  грантов (оплаченных кредитов) и всей истории потребления.
- **Каталог — единственное, что переживает потерю базы** (JSON в
  `openmeter-resources`). Customer'ы заводятся заново при входе, гранты — нет:
  сверки покупок с грантами в billing-adapter нет, восстанавливать пришлось бы
  руками.
- **Ключ шлюза различает приложения, но не пользователей**: `subject` в событии
  задаёт вызывающий. Поэтому ключ выдаётся только серверным бэкендам, никогда
  браузеру или мобильному клиенту. Пользовательские запросы (баланс, список
  пакетов) идут через сервис, который проверяет токен пользователя и берёт
  `subject` из него.
- От чарта OpenMeter остались два Deployment'а с нулём подов и три CronJob'а с
  расписанием «31 февраля» (биллинг на подписках). Это намеренно, а не забытый
  мусор: `enabled`-флагов у них в чарте нет.
