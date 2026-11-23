# The SOCKS5 relay (server.js) in a container: for Fly.io, Koyeb, Render ... or any server that has Docker.
#
#   docker build -t socks-relay .
#   docker run -d --name socks-relay --restart always -p 1080:1080 \
#     -e SOCKS_USER=some-user-name -e SOCKS_PASS=a-long-random-password socks-relay
#
# SOCKS_USER and SOCKS_PASS are required: the relay refuses to start without them (a relay without a password would be an
# open proxy for the whole internet). The other settings of server.js (BLOCKED_PORTS, MAX_CONNECTIONS ...) are plain
# -e variables too.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

WORKDIR /app
# package.json says "type": "module", which server.js needs
COPY package.json server.js ./

ENV NODE_ENV=production \
    SOCKS_PORT=1080

EXPOSE 1080
USER node
CMD ["node", "server.js"]
