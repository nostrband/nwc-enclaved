# Build layer
FROM eclipse-temurin:21-jre-jammy AS build

# Lock environment for reproducibility
ARG SOURCE_DATE_EPOCH
ENV TZ=UTC
WORKDIR /app

RUN echo "Timestamp" ${SOURCE_DATE_EPOCH}

# nodejs package sources
COPY ./nodesource_setup.sh .
RUN ./nodesource_setup.sh && rm ./nodesource_setup.sh

# install stuff w/ specific versions
RUN DEBIAN_FRONTEND=noninteractive apt-get update
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash=5.1-6ubuntu1.1 \
    wget=1.21.2-2ubuntu1.1 \
    unzip=6.0-26ubuntu3.2 \
    nodejs=24.0.1-1nodesource1

#RUN apt show nodejs
RUN apt clean 
RUN rm -Rf /var/lib/apt/lists/* /var/log/* /tmp/* /var/tmp/* /var/cache/ldconfig/aux-cache

# phoenix as separate user, it crashes if launched
# as root in our setup
RUN useradd -m phoenix
WORKDIR /home/phoenix
RUN wget https://github.com/ACINQ/phoenixd/releases/download/v0.5.1/phoenixd-0.5.1-linux-x64.zip
RUN sha256sum ./phoenixd-0.5.1-linux-x64.zip | grep 0ad77df5692babfc6d53f72d7aaa6ce27fffce750beea9a4965c4fad6805f0af
RUN unzip -j phoenixd-0.5.1-linux-x64.zip
RUN rm phoenixd-0.5.1-linux-x64.zip phoenix-cli
RUN chown -R phoenix:phoenix *

# other binaries
WORKDIR /app

# supervisord
RUN wget https://github.com/ochinchina/supervisord/releases/download/v0.7.3/supervisord_0.7.3_Linux_64-bit.tar.gz
RUN sha256sum ./supervisord_0.7.3_Linux_64-bit.tar.gz | grep f0308bab9c781be06ae59c4588226a5a4b7576ae7e5ea07b9dc86edc0b998de0
RUN tar -xvzf ./supervisord_0.7.3_Linux_64-bit.tar.gz
RUN mv ./supervisord_0.7.3_Linux_64-bit/supervisord ./supervisord
RUN rm -Rf ./supervisord_0.7.3_Linux_64-bit ./supervisord_0.7.3_Linux_64-bit.tar.gz

# other files
COPY ./supervisord.conf .
COPY ./phoenix.sh ./nwc.sh ./run.sh .

# nwc-enclaved app
# Copy only package-related files first
COPY package.json package-lock.json ./
# Install dependencies 
RUN npm ci --ignore-scripts
# cleanup after npm install etc
RUN rm -Rf /tmp/*

# Copy the rest of the project
COPY src src
COPY tsconfig.json ./

# Mac has different default perms vs Linux
# FIXME what about /home/phoenix?
RUN chown -R root:root *
RUN chmod -R go-w *

# remove files generated on MacOS
RUN rm -Rf /root
RUN mkdir /root

# result layer to reduce image size and remove differing layers
FROM eclipse-temurin:21-jre-jammy AS server
WORKDIR /

# copy everything
COPY --from=build / /

# volumes to be preserved across updates
VOLUME /app/data/
VOLUME /home/phoenix/.phoenix/

# Run the server
ENTRYPOINT ["/app/run.sh"]
