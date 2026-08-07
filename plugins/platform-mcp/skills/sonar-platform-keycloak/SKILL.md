---
name: sonar-platform-keycloak
description: How to inspect or change Keycloak on sonar-prod via platform-mcp (keycloak_exec / keycloak_login). Use when the user asks about realms, clients, users, roles, FreeIPA login to Keycloak, or Admin API / kcadm against auth.infra.sonar-corp.ru.
---

# Keycloak через platform-mcp

Нужны VPN, Java 17+ (для `kcadm`) и сессия: `keycloak_login` → браузер → FreeIPA
(realm `master`, клиент `platform-mcp-cli`). Проверка: `keycloak_auth_status`.

```
keycloak_exec { "args": ["get", "realms"] }
keycloak_exec { "args": ["get", "users", "-r", "sonar-prod", "-q", "username=alice"] }
```

Мутации выполняются без confirm, но в ответе будет warning: конфиг едет GitOps
(CR keycloak-operator). Предпочтительны манифесты в `deploy/` проекта или
`platform/keycloak-config/` в infra — иначе оператор перетрёт правки при sync.

Клиент `platform-mcp-cli` заводится один раз в master
([bootstrap/keycloak](https://git.sonar-corp.ru/infra/k8s/platform/-/blob/main/bootstrap/keycloak/README.md)).
Пользователю нужна роль `admin` в master.
