FROM ghcr.io/cloud-cli/image-node:latest

ENV PIP_BREAK_SYSTEM_PACKAGES=1
RUN apk add --no-cache ffmpeg
COPY . .
RUN pnpm install
RUN pip3 install --no-cache-dir -r requirements.txt
