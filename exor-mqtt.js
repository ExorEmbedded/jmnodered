/**
 * Copyright 2013, 2016 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
    "use strict";
    var mqtt = require("mqtt");
    var util = require("util");
    var isUtf8 = require('is-utf8');
    var azure = require('azure-iot-common');
    var awsIot = require('aws-iot-device-sdk');
    var azureBase = azure.SharedAccessSignature;
    var azureEncodeUriComponentStrict = azure.encodeUriComponentStrict;
    var azureAnHourFromNow = azure.anHourFromNow;
    var azureMessage = azure.Message;
    var amqpCodec = require('amqp10/lib/codec');
    var eurotechProtoBuf = require('protobufjs');
    var eurotechByteBuffer = eurotechProtoBuf.ByteBuffer;
    var eurotechBuilder = eurotechProtoBuf.loadProtoFile(__dirname + '/edcpayload.proto');
    if (eurotechBuilder != null)
    {
        var eurotech = eurotechBuilder.build("edcdatatypes");
        if(typeof(eurotech) == 'undefined')            
        {
            return;
        }   
    }
    
    
    function matchTopic(ts,t) {
        if (ts == "#") {
            return true;
        }
        var re = new RegExp("^"+ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g,"\\$1").replace(/\+/g,"[^/]+").replace(/\/#$/,"(\/.*)?")+"$");
        return re.test(t);
    }

    function MQTTBrokerNode(n) {
        RED.nodes.createNode(this,n);

        // Configuration options passed by Node Red
        this.broker = n.broker;
        this.port = n.port;
        this.clientid = n.clientid;
        this.usetls = n.usetls;
        this.verifyservercert = n.verifyservercert;
        this.compatmode = n.compatmode;
        this.keepalive = n.keepalive;
        this.cleansession = n.cleansession;
        this.cloud = n.cloud;

        // Config node state
        this.brokerurl = "";
        this.connected = false;
        this.connecting = false;
        this.closing = false;
        this.options = {};
        this.queue = [];
        this.subscriptions = {};

        if (n.birthTopic) {
            this.birthMessage = {
                topic: n.birthTopic,
                payload: n.birthPayload || "",
                qos: Number(n.birthQos||0),
                retain: n.birthRetain=="true"|| n.birthRetain===true
            };
        }

        if (this.credentials) 
        {
            this.username = this.credentials.user;
            this.password = this.credentials.password;
        }

        this.keypath = n.keypath;
        this.certpath = n.certpath;
        this.capath = n.capath;
        
        // If the config node is missing certain options (it was probably deployed prior to an update to the node code),
        // select/generate sensible options for the new fields
        if (typeof this.usetls === 'undefined'){
            this.usetls = false;
        }
        if (typeof this.compatmode === 'undefined'){
            this.compatmode = true;
        }
        if (typeof this.verifyservercert === 'undefined'){
            this.verifyservercert = false;
        }
        if (typeof this.keepalive === 'undefined'){
            this.keepalive = 60;
        } else if (typeof this.keepalive === 'string') {
            this.keepalive = Number(this.keepalive);
        }
        if (typeof this.cleansession === 'undefined') {
            this.cleansession = true;
        }
        
        // Create the URL to pass in to the MQTT.js library
        var protocol = "";
        if (this.usetls)
            protocol = "mqtts://";
        else
            protocol = "mqtt://";

        if (this.brokerurl == "") 
        {
            if (this.broker != "") {
                this.brokerurl = protocol + this.broker + ":" + this.port;
            } else {
                this.brokerurl = protocol + "localhost:1883";
            }
        }

        if (!this.cleansession && !this.clientid) {
            this.cleansession = true;
            this.warn(RED._("mqtt.errors.nonclean-missingclientid"));
        }

        // Build options for passing to the MQTT.js API
        //Create SAS TOKEN FOR AZURE
        if (this.cloud === "AZURE")
        {
           var uri = azureEncodeUriComponentStrict(this.broker + '/devices/' + this.clientid);
	   var passwordObj = azureBase.create(uri, null, this.password, azureAnHourFromNow());
           this.password = passwordObj.toString();
           this.options.protocolId = 'MQTT';
           this.options.protocolVersion = 4;
        }
        else if (this.cloud === "BLUEMIX")
        {
            if (this.compatmode == "true" || this.compatmode === true)
            {
                this.options.protocolId = 'MQIsdp';
                this.options.protocolVersion = 3;
            }
        }

        this.options.clientId = this.clientid || 'mqtt_' + (1+Math.random()*4294967295).toString(16);
        this.options.username = this.username;
        if (typeof(this.password) != "undefined")
            this.options.password = new Buffer(this.password);
        else
            this.options.password = "";
        this.options.keepalive = this.keepalive;

        this.options.clean = this.cleansession;
        this.options.reconnectPeriod = RED.settings.mqttReconnectTime||5000;
        this.options.rejectUnauthorized = (this.verifyservercert == "true" || this.verifyservercert === true)
        
        if (this.cloud === "AWS")
        {
            this.options.keyPath = this.keypath;
            this.options.certPath = this.certpath;
            this.options.caPath = this.capath;
            this.options.host = this.broker;
            this.options.thingName = this.options.clientId;
            this.options.port = 8883;
        }

        if (n.willTopic) {
            this.options.will = {
                topic: n.willTopic,
                payload: n.willPayload || "",
                qos: Number(n.willQos||0),
                retain: n.willRetain=="true"|| n.willRetain===true
            };
        }

        // Define functions called by MQTT in and out nodes
        var node = this;
        this.users = {};

        this.register = function(mqttNode){
            node.users[mqttNode.id] = mqttNode;
            if (Object.keys(node.users).length === 1) {
                node.connect();
            }
        };

        this.deregister = function(mqttNode,done){
            delete node.users[mqttNode.id];
            if (node.closing) {
                return done();
            }
            if (Object.keys(node.users).length === 0) {
                if (node.client) {
                    return node.client.end(done);
                }
            }
            done();
        };

        this.connect = function () 
        {
            if (!node.connected && !node.connecting) {
                node.connecting = true;
                if (node.cloud === "AWS")
                    node.client = awsIot.device(node.options);
                else
                    node.client = mqtt.connect(node.brokerurl ,node.options);
                node.client.setMaxListeners(0);
                // Register successful connect or reconnect handler
                node.client.on('connect', function () 
                {
                    node.connecting = false;
                    node.connected = true;
                    node.log(RED._("mqtt.state.connected",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            node.users[id].status({fill:"green",shape:"dot",text:"common.status.connected"});
                        }
                    }
                    // Remove any existing listeners before resubscribing to avoid duplicates in the event of a re-connection
                    node.client.removeAllListeners('message');

                    // Re-subscribe to stored topics
                    for (var s in node.subscriptions) {
                        var topic = s;
                        var qos = 0;
                        for (var r in node.subscriptions[s]) {
                            qos = Math.max(qos,node.subscriptions[s][r].qos);
                            node.client.on('message',node.subscriptions[s][r].handler);
                        }
                        var options = {qos: qos};
                        node.client.subscribe(topic, options);
                    }

                    // Send any birth message
                    if (node.birthMessage) {
                        node.publish(node.birthMessage);
                    }
                });
                node.client.on("reconnect", function() {
                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            node.users[id].status({fill:"yellow",shape:"ring",text:"common.status.connecting"});
                        }
                    }
                })
                // Register disconnect handlers
                node.client.on('close', function (err) 
		{
                    if (node.connected)
                    {
                        node.connected = false;
                        node.log(RED._("mqtt.state.disconnected",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                        for (var id in node.users) {
                            if (node.users.hasOwnProperty(id)) {
                                node.users[id].status({fill:"red",shape:"ring",text:"common.status.disconnected"});
                            }
                        }
                    } else if (node.connecting) {
                        node.log(RED._("mqtt.state.connect-failed",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                    }
                });

                // Register connect error handler
                node.client.on('error', function (error) {
                    if (node.connecting) {
                        node.client.end();
                        node.connecting = false;
                    }
                });
            }
        };

        this.subscribe = function (topic,qos,callback,ref) {
            ref = ref||0;
            node.subscriptions[topic] = node.subscriptions[topic]||{};
            var sub = {
                topic:topic,
                qos:qos,
                handler:function(mtopic,mpayload, mpacket) {
                    if (matchTopic(topic,mtopic)) {
                        callback(mtopic,mpayload, mpacket);
                    }
                },
                ref: ref
            };
            node.subscriptions[topic][ref] = sub;
            if (node.connected) {
                node.client.on('message',sub.handler);
                var options = {};
                options.qos = qos;
                node.client.subscribe(topic, options);
            }
        };

        this.unsubscribe = function (topic, ref) {
            ref = ref||0;
            var sub = node.subscriptions[topic];
            if (sub) {
                if (sub[ref]) {
                    node.client.removeListener('message',sub[ref].handler);
                    delete sub[ref];
                }
                if (Object.keys(sub).length == 0) {
                    delete node.subscriptions[topic];
                    if (node.connected){
                        node.client.unsubscribe(topic);
                    }
                }
            }
        };

        this.publish = function (msg) 
        {
            if (node.connected) {
                if (!Buffer.isBuffer(msg.payload)) {
                    if (typeof msg.payload === "object") 
                    {
                        msg.payload = JSON.stringify(msg.payload);
                    } 
                    else if (typeof msg.payload !== "string") 
		    		{
                        msg.payload = "" + msg.payload;
                    }
                }

                var type = msg.topic;
                msg.payload = JSON.parse(msg.payload);

                var options = {
                    qos: msg.qos || 0,
                    retain: msg.retain || false
                };
                if (node.cloud === "AZURE")
                {
                    msg.topic = "devices/" + node.clientid + "/messages/events/type=" + type;
                    msg.payload = JSON.stringify(msg.payload);
                }
                else if (node.cloud === "BLUEMIX")
                {
                    var date = new Date();
                    date.toISOString();
                    msg.topic = "iot-2/evt/" + type + "/fmt/json";
                    var p = {d: msg.payload, ts: date};
                    msg.payload = JSON.stringify(p);
                }
                else if(node.cloud === "AWS")
                {
                    msg.topic = node.clientid + "/evt/" + type;
                    msg.payload = JSON.stringify(msg.payload);
                }
                else if (node.cloud === "EUROTECH")
                {
                    var date = new Date();
                    msg.topic =  "EDALab-FB/" + node.clientid + "/" + type + "/data";
                    var payload = new eurotech.EdcPayload();
                    payload.timestamp = date.getTime();
                    msg.payload.forEach(function(value, index)
                    {
                        payload.metric[index] = new eurotech.EdcPayload.EdcMetric();
                        payload.metric[index].name = value.n;
                        payload.metric[index].type = eurotech.EdcPayload.EdcMetric.ValueType.INT32;
                        payload.metric[index].int_value = value.v.v;
                    });

                    payload.position = new eurotech.EdcPayload.EdcPosition();
                    payload.position.latitude = 0.0;
                    payload.position.longitude = 0.0;
                    payload.position.altitude = 0.0;
                    payload.position.precision = 0.0;
                    payload.position.heading = 0.0;
                    payload.position.speed = 0.0;
                    payload.position.timestamp = 0;
                    payload.position.satellites = 0;
                    payload.position.status = 0;

                    var tempBuffer = eurotechByteBuffer.allocate(1024);
                    var buf = payload.encode(tempBuffer).flip().toBuffer();
                    msg.payload = buf;
                    console.log(eurotechByteBuffer.wrap(msg.payload).toDebug(true));
                }
                node.client.publish(msg.topic, msg.payload, options, function (err){return});
            }
        };

        this.on('close', function(done) {
            this.closing = true;
            if (this.connected) {
                this.client.once('close', function() {
                    done();
                });
                this.client.end();
            } else {
                done();
            }
        });

    }

    RED.nodes.registerType("exor-mqtt-broker",MQTTBrokerNode,{
        credentials: {
            user: {type:"text"},
            password: {type: "password"}
        }
    });

    function MQTTInNode(n) {
        RED.nodes.createNode(this,n);
        this.topic = n.topic;
        this.broker = n.broker;
        this.brokerConn = RED.nodes.getNode(this.broker);
        if (!/^(#$|(\+|[^+#]*)(\/(\+|[^+#]*))*(\/(\+|#|[^+#]*))?$)/.test(this.topic)) {
            return this.warn(RED._("mqtt.errors.invalid-topic"));
        }
	
        this.cloud = this.brokerConn.cloud;
	    this.clientid = this.brokerConn.clientid;
        var node = this;
        if (this.brokerConn) {
            this.status({fill:"red",shape:"ring",text:"common.status.disconnected"});
            if (this.topic) {
                node.brokerConn.register(this);

		        var type = this.topic;

		        if (node.cloud === "AZURE")
                {
                    this.topic = "devices/" + node.clientid + "/messages/devicebound/#";
                }
                else if (node.cloud === "BLUEMIX")
                {
		            this.topic = "iot-2/cmd/" + type + "/fmt/json";
                }
                else if (node.cloud === "AWS")
                {
		            this.topic = "devices/" + node.clientid + "/cmd/#";
                }
                else if (node.cloud === "EUROTECH")
                {
                    this.topic = "EDALab-FB/" + node.clientid + "/#";
                }

                this.brokerConn.subscribe(this.topic,1,function(topic,payload,packet) 
                {
			        if (node.cloud === "AZURE")
		            {
						payload = node.decodeAmqpInMqttMsg(payload);
						if (payload == null)
		                	payload = "";
						payload = payload.data;
					}
                    else if(node.cloud == "EUROTECH")
                    {
                        payload = eurotech.EdcPayload.decode(payload);
                        var obj = payload.metric[0];
                        var data = {tag: obj.name};
                        switch(obj.type)
                        {
                            case 3:
                                data.value = obj.int_value;
                                break;
                        }
                        payload = data;
                        payload = JSON.stringify(payload);
                    }

                    if (isUtf8(payload)) { payload = payload.toString('utf8'); }
                    var msg = {topic:topic,payload:payload, qos: packet.qos, retain: packet.retain};
                    if ((node.brokerConn.broker === "localhost")||(node.brokerConn.broker === "127.0.0.1")) {
                        msg._topic = topic;
                    }
                    node.send(msg);
                }, this.id);
                if (this.brokerConn.connected) {
                    node.status({fill:"green",shape:"dot",text:"common.status.connected"});
                }
            }
            else {
                this.error(RED._("mqtt.errors.not-defined"));
            }
            this.on('close', function(done) 
            {
                if (node.brokerConn) {
                    node.brokerConn.unsubscribe(node.topic,node.id);
                    node.brokerConn.deregister(node,done);
                }
            });
        } else {
            this.error(RED._("mqtt.errors.missing-config"));
        }

		this.decodeAmqpInMqttMsg = function(payload)
		{
			var decoded = amqpCodec.decode(payload, 0);
			if (!decoded)
			{
				return null;
			}
			var message = decoded[0];
			return message;
		}
    }
    RED.nodes.registerType("exor-mqtt in",MQTTInNode);

    function MQTTOutNode(n) {
        RED.nodes.createNode(this,n);
        this.topic = n.topic;
        this.qos = n.qos || null;
        this.retain = n.retain;
        this.broker = n.broker;
        this.brokerConn = RED.nodes.getNode(this.broker);
        var node = this;

        if (this.brokerConn) {
            this.status({fill:"red",shape:"ring",text:"common.status.disconnected"});
            this.on("input",function(msg) {
                if (msg.qos) {
                    msg.qos = parseInt(msg.qos);
                    if ((msg.qos !== 0) && (msg.qos !== 1) && (msg.qos !== 2)) {
                        msg.qos = null;
                    }
                }
                msg.qos = Number(node.qos || msg.qos || 0);
                msg.retain = node.retain || msg.retain || false;
                msg.retain = ((msg.retain === true) || (msg.retain === "true")) || false;
                if (node.topic) {
                    msg.topic = node.topic;
                }
                if ( msg.hasOwnProperty("payload")) {
                    if (msg.hasOwnProperty("topic") && (typeof msg.topic === "string") && (msg.topic !== "")) { // topic must exist
                        this.brokerConn.publish(msg);  // send the message
                    }
                    else { node.warn(RED._("mqtt.errors.invalid-topic")); }
                }
            });
            if (this.brokerConn.connected) {
                node.status({fill:"green",shape:"dot",text:"common.status.connected"});
            }
            node.brokerConn.register(node);
            this.on('close', function(done) {
                node.brokerConn.deregister(node,done);
            });
        } else {
            this.error(RED._("mqtt.errors.missing-config"));
        }
    }
    RED.nodes.registerType("exor-mqtt out",MQTTOutNode);
};
