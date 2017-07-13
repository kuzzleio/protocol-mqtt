'use strict';

const
  Bluebird = require('bluebird'),
  mosca = require('mosca');

class MqttProtocol {
  constructor () {
    this.protocol = 'mqtt';
    this.server = null;

    this.context = null;
    this.entryPoint = null;
    this.kuzzle = null;

    this.connections = new Map();
    this.connectionsById = {};
  }

  init (entryPoint, context) {
    this.config = Object.assign({
      port: 1883,
      requestTopic: 'Kuzzle/request',
      responseTopic: 'Kuzzle/response',
      allowPubSub: false
    }, entryPoint.config.protocols.mqtt || {});

    this.entryPoint = entryPoint;
    this.kuzzle = this.entryPoint.kuzzle;
    this.context = context;

    this.server = new mosca.Server({
      port: this.config.port,
      // We use default in-memory pub/sub backend to avoid external dependencies
      backend: {}
    });

    /*
     To avoid ill-use of our topics, we need to configure authorizations:
     * "requestTopic": should be publish-only, so no one but this plugin can listen to this topic
     * "responseTopic": should be subscribe-only, so no one but this plugin can write in it
     */
    this.server.authorizePublish = (client, topic, payload, callback) => {
      if (this.config.allowPubSub) {
        const isAllowed = topic !== this.config.responseTopic
          && topic.indexOf('#') === -1
          && topic.indexOf('+') === -1;
        callback(null, isAllowed);
      }
      else {
        callback(null, topic === this.config.requestTopic);
      }
    };

    this.server.authorizeSubscribe = (client, topic, callback) => {
      const isAllowed = topic !== this.config.requestTopic
        && topic.indexOf('#') === -1
        && topic.indexOf('+') === -1;

      callback(null, isAllowed);
    };

    return new Bluebird(resolve => {
      this.server.on('ready', () => {
        this.server.on('clientConnected', client => this.onConnection(client));
        this.server.on('clientDisconnecting', client => this.onDisconnection(client));
        this.server.on('clientDisconnected', client => this.onDisconnection(client));
        this.server.on('published', (packet, client) => this.onMessage(packet, client));

        resolve();
      });
    });

  }

  broadcast (data) {
    this.context.debug('[mqtt] broadcast %a', data);

    const payload = JSON.stringify(data.payload);

    for (const channel of data.channels) {
      this.server.publish({topic: channel, payload});
    }
  }

  disconnect (connectionId, message = 'Connection closed by remote host') {
    this.context.debug('[mqtt] disconnect: connection id: %s, message: %s', connectionId, message);

    if (!this.connectionsById[connectionId]) {
      return;
    }

    this.connectionsById[connectionId].close(undefined, message);
  }

  joinChannel () {
    // do nothing
  }

  leaveChannel () {
    // do nothing
  }

  notify (data) {
    this.context.debug('[mqtt] notify %a', data);

    if (!this.connectionsById[data.connectionId]) {
      return;
    }

    const
      client = this.connectionsById[data.connectionId],
      payload = JSON.stringify(data.payload);

    for (const channel of data.channels) {
      client.forward(channel, payload, {}, channel, 0);
    }
  }

  /**
   * @param {Client} client
   */
  onConnection (client) {
    this.context.debug('[mqtt] onConnection: %s', client.id);

    try {
      const connection = new this.context.ClientConnection(this.protocol, [client.connection.stream.remoteAddress], {});
      this.entryPoint.newConnection(connection);

      this.connections.set(client, connection.id);
      this.connectionsById[connection.id] = client;
    }
    catch (e) {
      this.context.log.error('[plugin-mqtt] Unable to register new connection\n%s', e.stack);
      client.close(undefined, 'failed to register connection');
    }
  }

  /**
   * @param {Client} client
   */
  onDisconnection (client) {
    this.context.debug('[mqtt] onDisconnection %s', client.id);

    if (this.connections.has(client)) {
      const connectionId = this.connections.get(client);

      this.connections.delete(client);
      delete this.connectionsById[connectionId];
      this.entryPoint.removeConnection(connectionId);
    }
  }

  /**
   * @param packet
   * @param client
   */
  onMessage (packet, client) {
    this.context.debug('[mqtt] onMessage packet: %a', packet);

    if (packet.topic === this.config.requestTopic && packet.payload && client.id) {
      const connectionId = this.connections.get(client);

      if (connectionId === undefined) {
        return;
      }

      const
        payload = JSON.parse(packet.payload.toString()),
        request = new this.context.Request(payload, {
          connectionId: connectionId,
          protocol: this.protocol
        });

      return this.entryPoint.execute(request, response => {
        client.forward(this.config.responseTopic, JSON.stringify(response.content), {}, this.config.responseTopic, 0);
      });
    }
  }

}

module.exports = MqttProtocol;

