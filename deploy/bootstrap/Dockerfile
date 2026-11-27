FROM alpine:3.20
RUN apk add --no-cache bash curl jq
COPY bootstrap.sh /bootstrap.sh
ENTRYPOINT ["/bin/bash", "/bootstrap.sh"]
