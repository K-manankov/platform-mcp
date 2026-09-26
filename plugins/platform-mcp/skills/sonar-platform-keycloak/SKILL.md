---
name: sonar-platform-keycloak
description: Work with the shared Keycloak on sonar-prod via platform-mcp and keycloak-operator. Use for realms, clients, users, roles, organizations, FreeIPA sign-in, B2C/B2B login flows, project Keycloak CRs, or Admin API access. Distinguish the public auth.sonar-corp.ru issuer from the VPN-only auth.infra.sonar-corp.ru Admin API.
---

# Keycloak через platform-mcp

## Публичный issuer и внутренний Admin API

Инстанс один на `sonar-dev` и `sonar-prod`. `KC_HOSTNAME` задаёт публичный
`https://auth.sonar-corp.ru`; issuer realm'ов — соответственно
`https://auth.sonar-corp.ru/realms/sonar-dev` и
`https://auth.sonar-corp.ru/realms/sonar-prod`. Именно эти значения должны
проверять OIDC-клиенты, независимо от маршрута их серверных запросов.

`https://auth.infra.sonar-corp.ru` — внутренний адрес консоли и Admin REST API.
Для `platform-mcp` оставляйте `KEYCLOAK_BASE_URL` внутренним: `keycloak_exec`
использует его для `kcadm`, поэтому нужны VPN и доверие к корпоративному CA.
`keycloak_login` читает discovery через внутренний адрес, но Keycloak объявляет
в нём публичный issuer и публичные URL авторизации и обмена токена; браузер
идёт на `auth.sonar-corp.ru`. Подмена `KEYCLOAK_BASE_URL` на публичный адрес
сломает `keycloak_exec`, поскольку публичный NPM ограничивает `/admin/*`.

У приложения могут быть разные адреса для OIDC и Admin API. Внешний сервер
без доступа к VPN использует публичный OIDC URL; доступ к Admin API ему
настраивают отдельно с узким правилом по исходящему IP и служебной учёткой.
Смена DNS/адреса Admin API не меняет `iss` в токенах.

Нужны VPN, Java 17+ (для `kcadm`) и сессия: `keycloak_login` → браузер → FreeIPA
(realm `master`, клиент `platform-mcp-cli`). Проверка: `keycloak_auth_status`.
Клиент `platform-mcp-cli` заводится один раз в `master`
([bootstrap/keycloak/README.md](https://git.sonar-corp.ru/infra/k8s/platform/-/blob/main/bootstrap/keycloak/README.md)),
пользователю нужна роль `admin` в `master`.

## `keycloak_exec` — для чтения и проверки гипотез на dev

Аргумент — массив `kcadm`, адрес и токен подставляются сервером
(`--server`/`--config`/`--no-config` запрещены):

```
keycloak_exec { "args": ["get", "realms"] }
keycloak_exec { "args": ["get", "clients", "-r", "sonar-prod", "-q", "clientId=demo-frontend"] }
keycloak_exec { "args": ["get", "users", "-r", "sonar-prod", "-q", "username=alice"] }
keycloak_exec { "args": ["get", "roles", "-r", "sonar-dev"] }
```

Если CLI отвечает `Unknown options: '--config'`, проверить версию запущенного
MCP и перезапустить его после обновления. Исправленный сервер размещает
`--config` после подкоманды `get`, как требует `kcadm`. Установка новой версии
плагина сама по себе не заменяет уже работающий процесс MCP. Не обходить эту
ошибку чтением локальных токенов или выдачей новых прав.

Чтение — основной и безопасный сценарий, confirm не нужен. Мутации
(`create`/`update`/`delete`) через этот инструмент **тоже выполняются без
confirm**, но живут только до ближайшей сверки: `keycloak-operator`
пересверяется с Keycloak каждые 5 минут (`syncPeriod`,
`platform/keycloak-operator/values.yaml`) и приводит realm к состоянию,
описанному CR в Git. Правка через `kcadm`, как и через UI, переживёт максимум
один цикл сверки — дальше без следа, и это касается обоих realm'ов
одинаково, `sonar-dev` не исключение.

Из этого — рабочий паттерн, а не запрет на мутации: `sonar-dev` годится как
песочница для проверки гипотезы, прежде чем описывать то же самое манифестом.
Например, `kcadm create` тестового клиента или роли в `sonar-dev`, чтобы
посмотреть, как поведёт себя приложение или ответит Admin API, а потом —
`get clients/{id}` посмотреть, что реально создалось, `get users -q
username=...` проверить, что LDAP-федерация подтянула нужного пользователя.
Держать в уме, что это одноразовый прогон: постоянная версия той же сущности
всегда идёт отдельным шагом — CR в `deploy/` проекта (ниже).

## Манифесты для оператора: как писать и подключать

Клиенты, роли, группы и организации конкретного проекта не создаются ни в
UI, ни через `keycloak_exec` на постоянной основе — они описываются CR
`keycloak-operator` и лежат в `deploy/` репозитория самого проекта, рядом с
`Deployment`/`ExternalSecret`. Тот же Argo CD `Application`
(`ApplicationSet projects`), что катит остальной `deploy/`, применяет их в
namespace проекта — ни отдельного CI-шага, ни PR в инфра-репозиторий не
нужно.

**Класть их надо в оверлей окружения** (`overlays/test/`, `overlays/prod/`),
как и `ExternalSecret`. Причина — realm'ы разведены по контурам: тест живёт в
`sonar-dev`, прод в `sonar-prod`, а у `KeycloakClient` один `clusterRealmRef`.
Одним CR два контура не покрыть, значит клиентов два — по одному на realm. Так
сделано во всех проектах кластера.

Две ловушки, обе от того, что `nameSuffix` оверлея переименовывает сами
объекты, но не ссылки внутрь CR:

- `clientSecretRef.name` пишется литерально, с суффиксом окружения
  (`litellm-sso-oidc-prod`): Secret'ы обоих контуров лежат в одном namespace и
  без суффикса затрут друг друга;
- то же с `serviceAccountRef.name` в `KeycloakRoleMapping` — там указывается
  `metadata.name` клиента уже после `nameSuffix`.

`clientId` при этом у контуров может совпадать: они в разных realm'ах и друг
другу не мешают (так у `sonar-compute-openmeter`). Разводить контуры можно и
разными `clientId`, но это не обязательно.

Эталонный шаблон — `infra/examples/keycloak-project.yaml`:

```yaml
# Публичный клиент: authorization code + PKCE, секрета нет и быть не может.
apiVersion: keycloak.hostzero.com/v1beta1
kind: KeycloakClient
metadata:
  name: demo-frontend
spec:
  clusterRealmRef:
    name: sonar-dev          # или sonar-prod — так выбирается контур
  clientId: demo-frontend    # неизменяемо после создания
  definition:                # ClientRepresentation Keycloak как есть, не валидируется
    enabled: true
    protocol: openid-connect
    publicClient: true
    standardFlowEnabled: true
    redirectUris: ["https://demo.sonar-corp.ru/*"]
    attributes: {pkce.code.challenge.method: S256}
---
# Конфиденциальный клиент: секрет генерирует оператор, в Git и в Vault руками не кладётся.
apiVersion: keycloak.hostzero.com/v1beta1
kind: KeycloakClient
metadata:
  name: demo-backend
spec:
  clusterRealmRef: {name: sonar-dev}
  clientId: demo-backend
  definition:
    enabled: true
    protocol: openid-connect
    publicClient: false
    serviceAccountsEnabled: true
  clientSecretRef:
    name: demo-backend-oidc
    create: true   # false — если секрет приезжает откуда-то ещё (например, ExternalSecret из Vault)
```

Полный пример — там же ещё `KeycloakRole`, `KeycloakGroup`,
`KeycloakOrganization`. За остальными полями CRD и всем, что не покрыто
примером (`KeycloakComponent`, `KeycloakIdentityProvider`,
`KeycloakAuthenticationFlow` и т.д.), — документация самого оператора,
[Hostzero-GmbH/keycloak-operator](https://github.com/Hostzero-GmbH/keycloak-operator).

Публичный фронтенд-клиент — это ещё и карточка во вкладке «Приложения»
personal-lk (`/account/applications`): `definition.name`/`description`/
`rootUrl`+`baseUrl`/`attributes.logoUri`/`alwaysDisplayInConsole` рисуются
на ней как есть, без отдельного описания «для каталога». Без
`alwaysDisplayInConsole: true` приложение не видно в общем каталоге, пока
пользователь с ним не взаимодействовал хотя бы раз. Подробности и разбор
полей — `infra`, `platform/keycloak-config/README.md`, раздел «Каталог
приложений в личном кабинете».

## B2C или B2B: как клиент выбирает страницу входа

Это первое, что нужно решить, описывая `KeycloakClient`, и решается оно одной
строкой — присутствием scope `organization` в `definition.defaultClientScopes`.

Браузерный флоу `sonar-browser`
([11-browser-flow.yaml](https://git.sonar-corp.ru/infra/k8s/platform/-/blob/main/platform/keycloak-config/11-browser-flow.yaml))
— это копия встроенного `browser`, у которой подпоток организаций закрыт
условием «Condition - client scope» со значением `organization`. Отсюда две
разные страницы входа:

| `defaultClientScopes` | Что видит пользователь |
|---|---|
| без `organization` (B2C) | Одна форма: почта, пароль, кнопки IdP, ссылка на регистрацию |
| с `organization` (B2B) | Почта → при членстве больше чем в одной организации выбор организации → пароль. Плюс автоматический редирект на IdP организации по домену почты |

```yaml
    # B2B-клиент: список задаётся целиком, ClientRepresentation его
    # заменяет, а не дополняет. Шесть первых значений — стандартный набор
    # Keycloak для openid-connect, седьмым дописывается organization.
    defaultClientScopes:
      - acr
      - basic
      - email
      - profile
      - roles
      - web-origins
      - organization
```

B2C-клиенту не нужно писать ничего: без этого поля Keycloak раздаёт свой
набор по умолчанию, а `organization` в нём лежит как optional и в запрос сам
не попадает.

Три вещи, на которых тут легко ошибиться:

- **Двухшаговость нельзя убрать настройкой клиента у встроенного флоу.** У
  Keycloak подпоток организаций условный по «Condition - user configured», а
  это условие всегда истинно, пока организации включены в realm'е. Ровно
  поэтому у нас свой флоу, а не стоковый `browser`.
- **Имя scope менять нельзя.** Тот же самый `organization` включает и экран
  выбора организации: в `OrganizationScope` значение `ANY` — это пустая
  строка после двоеточия, то есть ровно `organization`. `organization:*` это
  `ALL`, а `organization:<alias>` — `SINGLE`, и экран выбора они не включают.
- **Ссылка на регистрацию у B2B может пропасть не по вашей вине.** Если к
  организации привязан identity provider без `hideOnLogin`, Keycloak на шаге
  почты подменяет бин `realm` на `OrganizationAwareRealmBean`, а тот
  возвращает `registrationAllowed = false` — чтобы человек регистрировался
  через брокер. Атрибут `sonar.registerLink` это не перебивает.

Сами кнопки IdP и ссылка на регистрацию включаются атрибутами клиента
`sonar.identityProviders` (список alias через запятую) и
`sonar.registerLink: "true"` — без них форма входа показывает только почту и
пароль, независимо от флагов realm'а.

Что важно при написании:
- `spec.clusterRealmRef.name` — единственное место выбора контура
  (`sonar-dev`/`sonar-prod`); свой realm проект завести не может.
- Имена — с префиксом проекта (`<project>-<что-то>`). Границы между
  проектами внутри realm'а на уровне оператора нет — ничто не мешает CR из
  чужого namespace завести клиента с любым `clientId`, включая занятый.
  Единственная защита — конвенция имён и ревью MR.
- Удаление буквально: у CR финализаторы, снос манифеста из Git → Argo прунит
  CR → оператор удаляет сущность в самом Keycloak (клиента вместе с его
  секретом; снос namespace'а — все сущности проекта разом).
- Дрейф — тот же принцип, что у `keycloak_exec` выше: то, что уже описано
  манифестом, оператор откатит на ближайшей сверке, если поправить руками в
  обход Git.

## OTP и подтверждение MFA в токене

У `auth-otp-form` в общих `sonar-browser` обоих realm'ов должен быть
`authenticatorConfig.default.reference.value: otp`. Это метка выполненного
шага для mapper `oidc-amr-mapper`: он добавляет `otp` в `amr` после реальной
проверки кода. Одного AMR mapper у клиента недостаточно, если reference шага
пустой. Не подставлять постоянный `amr` и не считать наличие OTP в профиле
доказательством MFA текущего входа.

При ошибке «MFA требуется», хотя код был введён:

1. Прочитать исполнения `sonar-browser` и конфигурацию именно `auth-otp-form`
   через Admin API. Проверить reference `otp` и AMR mapper клиента, включая
   выдачу claim в тот тип токена, который проверяет приложение.
2. Общий flow исправлять в `infra/k8s/platform`,
   `platform/keycloak-config/11-browser-flow.yaml`, с разрешением на этот
   репозиторий. Сохранить requirements и порядок исполнений. Не править
   общий flow через UI: оператор сверяет его с Git.
3. После GitOps-сверки проверить новый вход с OTP. Старый токен не изменится;
   вход через существующую SSO-сессию не равнозначен новой проверке кода.
   Не выводить токены, QR-коды, OTP и секреты в историю инструментов или чат.

Текущий flow запрашивает OTP условно, когда он настроен у пользователя:
`CONDITIONAL` → `conditional-user-configured` → `auth-otp-form`.
Обязательность MFA для доступа к конкретному приложению — отдельная политика
самого приложения. Если пользователь просит временно сделать MFA
необязательной, менять политику проекта, сохраняя проверку подписи токена,
audience, ролей и организации. Не отключать OTP в общем flow.

## UUID выбранной организации

Scope `organization` выбирает контекст входа, но стандартный mapper может
не включать UUID организации (`addOrganizationId` выключен). Если приложение
сопоставляет UUID, задать проектный `oidc-organization-membership-mapper` с
`addOrganizationId: "true"` и отдельным claim, например `sonar_organization`.
Приложение должно проверять ровно одну выбранную организацию. Не брать
первую из нескольких и не удалять членства пользователя ради исправления
входа. Общий mapper других приложений без отдельного разрешения не менять.

## Общие сущности Keycloak — уже заведены, не создавать заново

Платформенная часть — в `infra/platform/keycloak-config/`, проектные CR
только ссылаются на неё:

- **`ClusterKeycloakInstance sonar`** — один инстанс на всё.
- **`ClusterKeycloakRealm sonar-dev` / `sonar-prod`** — единственная точка
  выбора контура для проекта через `clusterRealmRef.name`. Дев мягче
  (`sslRequired: external`, порог блокировки выше), прод жёстче
  (`sslRequired: all`) — иначе оба симметричны.
- **`KeycloakOrganization sonar`** (домен `sonar-corp.ru`) в обоих realm'ах —
  представляет саму компанию: и как потребителя собственных B2B-продуктов
  (наравне с любой компанией-клиентом), и как единственный тенант для
  приложений, которые делаются только для внутреннего использования и не
  распространяются вовне. Организация под конкретного клиента-компанию
  проекта (B2B) заводится отдельным CR (см. `demo-acme` в примере выше) — это
  не конфликтует с общей. **Организация = компания-тенант, и ничего кроме:**
  B2C-пользователь ни в какой организации не состоит, он просто живёт в
  realm'е; контейнера «для тех, у кого нет компании» нет и заводить его не
  надо. Подробнее — `infra`, `platform/keycloak-config/README.md`, раздел
  «Модель организаций».
- **`KeycloakAuthenticationFlow sonar-browser`** в обоих realm'ах — браузерный
  флоу входа, на него смотрит `browserFlow` каждого realm'а. Свой флоу
  проекту не нужен и заводить его не следует: этот один обслуживает и B2C, и
  B2B, см. следующий раздел.
- **Admin-роль в приложении** — смэппить на группу `dep_it` (разработчики) или
  завести свою группу проекта и добавить в неё нужных людей поимённо; членство
  в обоих случаях — разовое действие руками (Admin Console/API), не CR: у
  оператора нет типа для «добавить существующего/федерированного пользователя
  в группу», а завести свой `KeycloakGroup`/`KeycloakUser` с именем, которое
  совпадает с уже существующей группой/пользователем (например, `dep_it`),
  значит взять чужую сущность под управление CR — её же снос из Git тогда
  удалит её из Keycloak целиком. Подробнее и как сделать безопасно — `infra`,
  `platform/keycloak-config/README.md`, раздел «Права администратора в
  приложении».
- **Федерация пользователей из FreeIPA** (`KeycloakComponent
  freeipa-ldap-*`) и синхронизированные группы `dep_it`/`dep_sales`
  (`freeipa-ldap-groups-*`) — источник пользователей и департаментских групп
  один на всю компанию; свою федерацию каталога проекту заводить не нужно и
  незачем.
- **Технические клиенты в `master`**, заводятся один раз руками не проектом:
  `keycloak-operator` (service account, приводит Keycloak к манифестам) и
  `platform-mcp-cli` (public-клиент для входа инженеров через
  `keycloak_login`, см. выше).

Практически для разработки отдельного проекта это значит: сам проект решает
только `clusterRealmRef` и имена своих
`KeycloakClient`/`KeycloakRole`/`KeycloakGroup`/`KeycloakOrganization` —
инстанс, realm'ы, организация компании и источник пользователей уже есть и
переиспользуются.
