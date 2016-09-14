module.exports = function(RED)
{
	function AlarmNodeOut(config)
	{
		RED.nodes.createNode(this, config);
        this.all = config.all;
        if (typeof(this.all) == "undefined" || this.all == false)
            this.hmiID = config.hmiID;
        else
            this.hmiID = "*";
        
        this.configSSE = RED.nodes.getNode(config.sse);
        
        node = this;
        node.manageData = function(data)
        {
            var msg = {"topic": "alarms", "payload" : data};
            node.send(msg);
        }
	}
	RED.nodes.registerType("hmi-alarm out", AlarmNodeOut);
	
	RED.httpAdmin.post("/hmi-alarm/:id/:state", RED.auth.needsPermission("hmi-alarm.write"), function(req, res)
	{
		var node = RED.nodes.getNode(req.params.id);
		var state = req.params.state;

		if (node != null && typeof node !== "undefined")
		{
			if (state === "enable")
			{
                node.configSSE.subscription(node, node.configSSE, node.id, node.hmiID, "alarm");
				res.sendStatus(200);
			}
			else if(state === "disable")
			{
                node.configSSE.unsubscription(node.configSSE, node.id, node.hmiID, "alarm");
				res.sendStatus(201);
			}
			else
			{
				res.sendStatus(404);
			}
		}
		else
		{
			res.sendStatus(404);
		}
	});
    
    function AlarmNodeIn(config)
	{
		RED.nodes.createNode(this, config);
        this.hmiID = config.hmiID;
        this.configSSE = RED.nodes.getNode(config.sse);
        
        node = this;

        this.on('input', function (msg) 
        {
            node.configSSE.writeTag(node.configSSE, node.hmiID, msg.payload);
        });

	}
	RED.nodes.registerType("hmi-alarm in", AlarmNodeIn);
}

