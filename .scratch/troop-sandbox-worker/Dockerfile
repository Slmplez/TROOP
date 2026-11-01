# THROWAWAY. Candidate base tags; actual digests/package versions recorded after a real build.
FROM rust:1.92-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 xvfb openbox xterm x11vnc novnc websockify \
    firefox-esr xdotool util-linux procps tini fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home --shell /bin/sh troop \
    && install -d -o troop -g troop /workspace \
    && install -d -m 0700 /control /run/troop-control \
    && dpkg-query -W > /opt/troop-debian-packages.txt
COPY --from=build /src/target/release/troop-sandbox-prototype /usr/local/bin/troop-worker
COPY start.py /opt/troop/start.py
VOLUME ["/workspace", "/control"]
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/bin/python3", "/opt/troop/start.py"]
