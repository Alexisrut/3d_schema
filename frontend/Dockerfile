# Фронтенд: сборка Vite, раздача через nginx.
#
# Двухэтапный образ. В итоговый попадает только каталог dist и nginx —
# ни Node, ни node_modules (сотни мегабайт и своя поверхность атаки) на
# сервере не нужны: Vue собирается в статические файлы.

# ---------------------------------------------------------------- сборка
FROM node:20-alpine AS build

WORKDIR /app

# npm ci, а не npm install: ставит строго по package-lock.json. Иначе сборка
# на сервере может подтянуть другие версии, чем те, на которых всё проверено.
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------- раздача
FROM nginx:1.27-alpine

# Свой конфиг заменяет стандартный: нужен и SPA-fallback, и проксирование
# /api, /media, /ws на бэкенд — фронтенд ходит относительными путями.
RUN rm /etc/nginx/conf.d/default.conf
COPY deploy/nginx.conf /etc/nginx/conf.d/app.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
