var EventSource = require('eventsource');
var RandomString = require('randomstring');
var Http = require("http");
var Querystring = require("querystring");

module.exports = function(RED) 
{
    function HMISSENode(config) 
    {
        RED.nodes.createNode(this, config);
        this.host = config.host;
        this.port = config.port;
        this.period = config.period;
        this.id = RandomString.generate({length: 12, charset: 'numeric'});
        this.requestId = "cgi/sse?id=" + this.id;
        this.elements = {};
        this.elementProperty = {"tag" :  0, "alarm":  0, "group":  0};
        this.request = {"tag": "", "alarm": "", "group": ""};
        this.allRequest = {"tag": false, "alarm": false, "group": false};
        this.allRequestStart = {"tag": false, "alarm": false, "group": false};
        this.subscriptions = {};
        this.nodeSSE = null;
        var node = this;
       
        //Private function
        function manageConnection()
        {

            var subsIsEmpty = Object.keys(node.subscriptions).length == 0 ? true : false;
            var connectionString = "http://" + node.host + ":" + node.port + "/" + node.requestId;

            if (!subsIsEmpty && node.nodeSSE == null)
            {
                node.nodeSSE = new EventSource(connectionString + "&minPeriod=" + node.period);
                var es = node.nodeSSE;
                handleConnection(es);
            }

            var path = "";
            if (node.allRequestStart[node.hmiType] && !node.allRequest[node.hmiType])
            {
                unsubscribeAll();
            }
            else if (node.allRequestStart[node.hmiType] 
                    && node.allRequest[node.hmiType])
                return;
            else if (node.allRequest[node.hmiType])
                node.allRequestStart[node.hmiType] = true;
            
            
            sendRequest(node.request[node.hmiType]);
            
            if(subsIsEmpty && node.nodeSSE != null)
            {
                node.nodeSSE.close();
                node.nodeSSE = null;
                return
            }

        }
        
        function unsubscribeAll()
        {
            node.allRequestStart[node.hmiType] = false;
            if (node.hmiType == "tag")
                path = "&_nt=*";     
            else if (node.hmiType == "alarm")
                path = "&_na=*";     
            else if (node.hmiType == "group")
                path = "&_ng=*";
            sendRequest(path);
        }

        function sendRequest(path)
        {
            if (path == "")
                return;

            path = node.requestId + path;
		
            console.log("SEND GET REQUEST WITH " + path);
            var options = 
            {
                host: node.host,
                port: node.port,
                path: "/" + path,
                method: "GET",
                headers: 
                {
                    'Content-Type': 'application/json'
                }
            };

            var req = Http.request(options, function(res)
            {
            });

            req.on('error', function(error) 
            {
                console.log("Error " + error);
            });
            req.end(); 
            
        }

        function returnData(hmiName, data)
        {
            if (typeof(node.subscriptions[hmiName]) != "undefined")
            {
                node.subscriptions[hmiName].forEach(function(v,i)
                {
                    v.node.manageData(data);
                });
            }
        }

        function handleConnection(es)
        {
            es.onopen = function(event)
            {
                console.log("Open connection");
            }

            es.onerror = function(event)
            {
                console.log("Error" + JSON.stringify(event));
            }

            es.addEventListener("tags", function(event)
            {
                data = JSON.parse(event.data);
                data.forEach(function(value, index)
                {
                    returnData(value.n, value);
                });

                returnData("*_tag", data);
            });
            
            es.addEventListener("alarms", function(event)
            {
		        data = JSON.parse(event.data);
                data.forEach(function(value, index)
                {
                    returnData(value.n, value);
                });

                returnData("*_alarm", event.data);
            });
        }

        function deregister()
        {
            setProperty();
            node.elements[node.hmiId]["subProperty"] = "_" + node.subProperty;
            createRequest();
            delete node.elements[node.hmiId];
            node.elementProperty[node.hmiType] -= 1;
        }

        function createRequest()
        {
            if (!node.allRequest[node.hmiType])
            {
                node.request[node.hmiType] = "";
                var hasElements = false;
                var indexes = {"tag" : 0, "alarm": 0, "group" : 0}
                for (key in node.elements)
                {
                    var value = node.elements[key];
                    var valueType = value["hmiType"];
                    var valueSubProperty = value["subProperty"] + indexes[valueType];
                    
                    indexes[valueType] += 1;

                    if (valueType != node.hmiType)
                        continue;

                    hasElements = true;
                    node.request[node.hmiType] += "&" + valueSubProperty + "=" + key;
                }

                if (hasElements)
                    node.request[node.hmiType] = "&" + node.property + "=" 
                        + node.elementProperty[node.hmiType]
                        + node.request[node.hmiType];  
            }
            else
                node.request[node.hmiType] = "&" + node.property + "=*";
        }

        function setProperty()
        {
            node.property = "";
            node.subProperty = "";
            
            switch(node.hmiType)
            {
                case "tag":
                    node.property = "nt";
                    node.subProperty = "t";
                    break;
                case "alarm":
                    node.property = "na";
                    node.subProperty = "a";
                    break;
                case "group":
                    node.property = "ng";
                    node.subProperty = "g";
                    break;
                 default:
                    return;
            }
        }

        function register()
        {
            setProperty();
            
            if (node.hmiId == "*")
            {
                node.allRequest[node.hmiType] = true;
            }
            else
            {
                node.elements[node.hmiId] = {};
                node.elements[node.hmiId]["subProperty"] = node.subProperty;
                node.elements[node.hmiId]["hmiType"] = node.hmiType;
                node.elementProperty[node.hmiType] += 1;
            }
            createRequest();
        }

        function removeSubscription(hmiId, idNode)
        {
            subs = node.subscriptions[hmiId];
            subs.forEach(function(value, index)
            {
                if(value["idNode"] == idNode)
                    subs.splice(index, 1);
            });

            if (subs.length == 0)
            {
                delete node.subscriptions[hmiId];
            }
        }

        function addSubscription(hmiId, idNode, hmi)
        {
            var reg = false;
            if (typeof(node.subscriptions[hmiId]) == "undefined")
            {
                node.subscriptions[hmiId] = [];
                reg = true;
            }
            node.subscriptions[hmiId].push({"idNode": idNode, "node": hmi});
            
            return reg;
        }
       
        //Public function
        node.subscription = function(hmi, config, idNode, hmiId, hmiType)
        {
            node = config;
            node.hmiId = hmiId;
            node.hmiType = hmiType;
            node.idNode = idNode;
            node.hmi = hmi;

            var reg = false;
            if (hmiId == "*")
            {
                var key = node.hmiId + "_" + node.hmiType;
                reg = addSubscription(key, idNode, hmi);
            }
            else
                reg = addSubscription(hmiId, idNode, hmi);

            if (reg)
                register();
            manageConnection();
         }
        
         node.unsubscription = function(config, idNode, hmiId, hmiType)
         {
            node = config;
            node.hmiId = hmiId;
            node.hmiType = hmiType;

            if (node.hmiId == "*")
            {
                var key = node.hmiId + "_" + node.hmiType;
                removeSubscription(key, idNode);

                node.allRequest[node.hmiType] = false;
                createRequest();
                manageConnection();
                return;
            }


            if (typeof(node.subscriptions[hmiId]) == "undefined")
                return;

            removeSubscription(hmiId, idNode);
            deregister();
            manageConnection();
         }

         node.writeTag = function(config, hmiId, value)
         {
            node = config;
            var path = "/cgi/writeTags.json";

            var data = Querystring.stringify({
                  n: 1,
                  t1: hmiId + ".0",
                  v1: value
            });

            var options = 
            {
                host: node.host,
                port: node.port,
                path: path,
                method: "POST",
		        headers : 
                {
			        'Content-Type' : 'application/x-www-form-urlencoded',
			        'Content-Length': Buffer.byteLength(data)
		        }
            };

            var req = Http.request(options, function(res)
            {
            });

            req.on('error', function(error) 
            {
                console.log(error);
            });
            req.write(data);
            req.end();

         }


    }

    RED.nodes.registerType("hmi-sse", HMISSENode);
}
