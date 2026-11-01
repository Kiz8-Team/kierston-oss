# Kierston evaluation environment.
#
# Ubuntu with python3, pip, bun and the pi coding agent. The agent reaches
# the data interface through the `adi` wrapper in /usr/local/bin (bin/kdi in
# this repo; the model-facing name is ADI, Allentown Data Interface, and the
# word Kierston or KDI must never be installed where the model can see it),
# which forwards to kdi_service.ts running on the host. The container holds no
# repository files, no database credentials and no direct database access.

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less unzip \
      python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Bun, pinned by the image tag rather than an install script.
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# A virtualenv keeps pip usable on Ubuntu 24.04 (PEP 668) and puts `pip
# install` within reach of the agent without root.
RUN useradd --create-home --shell /bin/bash agent \
 && python3 -m venv /opt/venv \
 && chown -R agent:agent /opt/venv
ENV PATH="/opt/venv/bin:${PATH}" \
    VIRTUAL_ENV=/opt/venv \
    PIP_DISABLE_PIP_VERSION_CHECK=1

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY bin/kdi /usr/local/bin/adi
COPY bin/km_search_places /usr/local/bin/km_search_places
COPY bin/km_address_lookup /usr/local/bin/km_address_lookup
# What the clients print; generated from model_visible_text.ts by gen_messages.ts.
COPY bin/messages.json /usr/local/share/adi/messages.json
RUN chmod 0755 /usr/local/bin/adi /usr/local/bin/km_search_places /usr/local/bin/km_address_lookup

# The pi coding agent, built for Linux by build-pi.sh. The binary reads its
# package.json, themes and templates from its own directory, so the whole
# directory is copied and only the executable is linked onto PATH.
COPY pi /opt/pi
RUN chmod 0755 /opt/pi/pi && ln -s /opt/pi/pi /usr/local/bin/pi
# Read by the runner (docker image inspect) into run.json; image labels are not visible inside a container.
ARG PI_VERSION=unknown
LABEL pi.version=$PI_VERSION
# The response clock, loaded by the runner only when a run sets a deadline.
COPY pi-ext /opt/pi-ext
# No update checks or changelog fetches at startup.
ENV PI_OFFLINE=1

# Where the KDI service listens, as seen from inside the container. Docker Desktop
# resolves host.docker.internal on its own; on Linux `evalenv run` adds it.
ENV AU=http://host.docker.internal:8765

RUN mkdir -p /work && chown agent:agent /work
USER agent
WORKDIR /work
CMD ["bash"]
