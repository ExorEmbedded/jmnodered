module.exports = function(RED)
{
	function TagOutNode(config)
	{
		RED.nodes.createNode(this, config);

		var flow = this.context().global;
		var globalNodes = flow.get("nodes"); 

        	this.all = config.all;
        	if (typeof(this.all) == "undefined" || this.all == false)
        	    this.hmiID = config.hmiID;
        	else
            		this.hmiID = "*";
        
       		this.configSSE = RED.nodes.getNode(config.sse);
        	this.configSSE.subscription(this, this.configSSE, this.id, this.hmiID, "tag");

		if (typeof(globalNodes) === "undefined")
		{
			globalNodes = [];
		}

        	outNode = this;
		globalNodes.push(outNode);
		flow.set("nodes", globalNodes);
        	outNode.manageData = function(data, node)
       	 	{
            		var msg = {"topic": "tags", "payload" : data};
            		node.send(msg);
        	}
		this.on('close', function()
		{
			outNode.configSSE.closeConnection(globalNodes);
			flow.set("nodes", []);
		});
	}
	RED.nodes.registerType("hmi-tag out", TagOutNode);
	
	RED.httpAdmin.post("/hmi-tag/:id/:state", RED.auth.needsPermission("hmi-tag.write"), function(req, res)
	{
		var node = RED.nodes.getNode(req.params.id);
		var state = req.params.state;

		if (node != null && typeof node !== "undefined")
		{
			if (state === "enable")
			{
                node.configSSE.subscription(node, node.configSSE, node.id, node.hmiID, "tag");
				res.sendStatus(200);
			}
			else if(state === "disable")
			{
                node.configSSE.unsubscription(node.configSSE, node.id, node.hmiID, "tag");
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
	
    function TagInNode(config)
	{
		RED.nodes.createNode(this, config);
        this.hmiID = config.hmiID;
        this.configSSE = RED.nodes.getNode(config.sse);

        node = this;
	    var param = node;

        this.on('input', function (msg) 
        {
			var payload = JSON.parse(msg.payload);
			if (payload.tag == param.hmiID)
			{
            			node.configSSE.writeTag(node.configSSE, payload.tag, payload.value);
			}
        });

	}

	RED.nodes.registerType("hmi-tag in", TagInNode);
}

