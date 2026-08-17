---
name: sonar-platform-keycloak
description: How to inspect or change Keycloak on sonar-prod via platform-mcp (keycloak_exec / keycloak_login), how to write and wire up KeycloakClient/KeycloakRole/KeycloakGroup/KeycloakOrganization manifests for keycloak-operator in a project's deploy/, and what shared Keycloak entities (realms sonar-dev/sonar-prod, the sonar organization, FreeIPA federation) already exist platform-wide. Use when the user asks about realms, clients, users, roles, FreeIPA login to Keycloak, Admin API / kcadm against auth.infra.sonar-corp.ru, onboarding a project's auth into Keycloak, or writing keycloak-operator CRs.
---

# Keycloak через platform-mcp

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

**Класть их надо в `base/`, а не в оверлей окружения** — в отличие от
`ExternalSecret`, который живёт как раз в оверлее. Клиент общий на проект:
test ходит в тот же клиент, что и prod, пока realm'ы общие. Положить
`KeycloakClient` в `overlays/test` и `overlays/prod` — значит получить два
клиента с разными `clientId` (оверлей добавит `nameSuffix`) там, где нужен
один. Разводить контуры по realm'ам (`clusterRealmRef`), а не по оверлеям.

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

## Общие сущности Keycloak — уже заведены, не создавать заново

Платформенная часть — в `infra/platform/keycloak-config/`, проектные CR
только ссылаются на неё:

- **`ClusterKeycloakInstance sonar`** — один инстанс на всё.
- **`ClusterKeycloakRealm sonar-dev` / `sonar-prod`** — единственная точка
  выбора контура для проекта через `clusterRealmRef.name`. Дев мягче
  (`sslRequired: external`, порог блокировки выше), прод жёстче
  (`sslRequired: all`) — иначе оба симметричны.
- **`KeycloakOrganization sonar`** (домен `sonar-corp.ru`) в обоих realm'ах —
  представление самой компании. Организация под конкретного клиента проекта
  заводится отдельным CR (см. `demo-acme` в примере выше) — это не
  конфликтует с общей.
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
