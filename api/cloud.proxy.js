/*
Copyright (c) 2014, Intel Corporation

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

"use strict";

var msg = require('../lib/cloud-message'),
    common = require('../lib/common'),
    udpServer = require('../lib/server/udp'),
    Sensor = require('../lib/sensors-store'),
    conf = require('../config'),
    configurator = require('../admin/configurator'),
    proxyConnector = require('../lib/proxies').getProxyConnector();

function IoTKitCloud(logger, deviceId, customProxy) {
    var deviceConf = common.getDeviceConfig();

    var me = this;
    me.logger = logger;
    me.secret = {'accountId' : deviceConf['account_id'],
                 'deviceToken' : deviceConf['device_token']};
    me.proxy = customProxy || proxyConnector;
    me.max_retries = deviceConf.activation_retries || 10;
    me.deviceId = deviceId;
    me.deviceName = deviceConf.device_name;
    me.gatewayId = deviceConf.gateway_id || deviceId;
    me.store = Sensor.init("device.json", me.logger);
    me.activationCode = deviceConf.activation_code;
    me.logger.debug('Cloud Proxy Created with Cloud Handler ', me.proxy.type);
}
IoTKitCloud.prototype.isActivated = function () {
    var me = this;
   if (!me.secret) {
        me.secret = {
            deviceToken: null,
            accountId: null
        };
    }
    var token  = me.secret.deviceToken;
    var account  = me.secret.accountId;
    if (token && token.length > 0) {
        if (account && account.length > 30) {
            return true;
        }
    }
    return false;
};
/**
 * Handler to wait the token from server,
 * the token is use to auth metrics send by the device
 * @param data
 */
IoTKitCloud.prototype.activationComplete = function (callback) {
    var me = this,
        toCall = callback;

    var handler = function (data) {
        me.logger.debug('Activation Data Received: ', data);
        if (data && (data.status === 0)) {
            me.secret.deviceToken = data.deviceToken;
            me.secret.accountId = data.accountId;
            me.activationCompleted = true;
            me.logger.info('Saving device token...');
            common.saveToDeviceConfig('device_token',me.secret.deviceToken);
            common.saveToDeviceConfig('account_id',me.secret.accountId);
        }
        me.setDeviceCredentials();
        toCall(data.status);
    };
    return handler;
};
/**
 * It will activate the device, by sending the activation code and receiving the token
 * from server if the toke is at device the activation will not called.
 * @param callback
 */
IoTKitCloud.prototype.activate = function (code, callback) {
    var me = this,
        toCall = callback;
    me.logger.debug('Starting Activate Process function');
    if ("function" === typeof code) {
        toCall = code;
        code = null;
    }
    function complete (status) {
        /**
        * It were sent ever activation the update Metadata,
         * since every start/stop the HW could change.
        */
       if (status === 0) {
           me.update(function() {
               toCall(status);
           });
       } else {
           toCall(status);
       }
    }
    if (!me.isActivated()) {
        var ActMessage = {
            deviceId: me.deviceId,
            code: code || me.activationCode
        };
        if (ActMessage.code == null) {
            me.logger.error("Device has not been activated, and activation code has not been set - exiting");
            process.exit(1);
        }
        me.logger.info('Activating ...');
        me.proxy.activation(ActMessage, me.activationComplete(complete));
    } else {
        // skip the update since we were already activated
        me.logger.info('Device has already been activated. Updating ...');
        me.setDeviceCredentials();
        complete(0);
    }
};

IoTKitCloud.prototype.setDeviceCredentials = function() {
    var me = this;
    me.proxy.setCredential(me.deviceId, me.secret.deviceToken);
};

IoTKitCloud.prototype.update = function(callback) {
    var me = this;
    msg.metadataExtended(me.gatewayId , function (doc) {
        if(me.deviceName){
            doc.name = me.deviceName;
        }
        doc.deviceToken = me.secret.deviceToken;
        doc.deviceId = me.deviceId;
        me.logger.info("Updating metadata...");

        if(proxyConnector.type === "rest"){
            //get device to read existing attributes
            me.proxy.getDevice(doc, function(result){

                //append custom attributes to update body
                for (var attributeName in result.attributes){

                    if(doc.attributes[attributeName] === undefined) {
                        doc.attributes[attributeName] = result.attributes[attributeName];
                    }
                }
                //update attributes
                me.updateAttributes(doc, callback);
            });
        }
        else {
            me.updateAttributes(doc, callback);
        }
        me.logger.info("Metadata updated.");

    });

};

IoTKitCloud.prototype.updateAttributes = function(doc, callback){
    var me = this;
    me.proxy.attributes(doc, function () {
        me.logger.debug("attributes has returned from ", me.proxy.type);
        if (callback) {
            callback();
        }
    });
};


IoTKitCloud.prototype.updateOld = function(callback) {
    var me = this;
    var doc = new msg.Metadata(me.gatewayId);
    doc.deviceToken = me.secret.deviceToken;
    doc.deviceId = me.deviceId;
    me.proxy.attributes(doc, function () {
        me.logger.debug("attributes has returned from ", me.proxy.type);
        if (callback) {
            callback();
        }
    });
};
IoTKitCloud.prototype.disconnect = function () {
  var me = this;
  me.proxy.disconnect();
};

IoTKitCloud.prototype.dataSubmit = function (metric, callback) {
    var me = this;
    metric.accountId = me.secret.accountId;
    metric.did = me.deviceId;
    metric.gatewayId = me.gatewayId;
    metric.deviceToken = me.secret.deviceToken;
    me.logger.debug("Metric doc: %j", metric, {});
    me.proxy.data(metric, function (dato) {
        if (callback) {
            return callback(dato);
        }
        return true;
    });

};
IoTKitCloud.prototype.regComponent = function(comp, callback) {
    var me = this;
    var doc = JSON.parse(JSON.stringify(comp)); //HardCopy to remove reference bind
    doc.deviceToken = me.secret.deviceToken;
    doc.deviceId =  me.deviceId;
    me.logger.debug("Reg Component doc: %j", doc, {});
    me.proxy.addComponent(doc, callback);
};
IoTKitCloud.prototype.desRegComponent = function() {
    /*
    var me = this;
    var doc =  JSON.parse(JSON.stringify(comp)); //HardCopy to remove reference bind
    doc.deviceToken = me.secret.deviceToken;
    me.logger.debug("DesReg Component doc: %j", doc, {});
    me.client.publish(buildPath(me.topics.device_component_del, me.deviceId),
                                doc,
                                me.pubArgs);*/
};

IoTKitCloud.prototype.test = function(callback) {
    var me = this;
    me.logger.info("Trying to connect to host ...");
    me.proxy.health(me.deviceId, function (result) {
          me.logger.debug("Response ", result);
          callback(result);
    });
};

IoTKitCloud.prototype.catalog = function (callback) {
    var me = this;
    var data = {
            deviceToken: me.secret.deviceToken,
            deviceId: me.deviceId
        };
    me.proxy.getCatalog(data , function (result) {
        if (result) {
            me.logger.debug("Catalog Response : %j ", result);
            var length = result.length;
            for (var i = 0; i < length; ++i) {
                 var o = result[i];
                me.logger.info("Comp: ", o.id, " ", o.dimension, " ", o.type );
            }
        }
        callback(result);
    });
};

IoTKitCloud.prototype.pullActuations = function () {
    var me = this;
    var data = {
        deviceToken: me.secret.deviceToken,
        deviceId: me.deviceId,
        accountId: me.secret.accountId
    };
    configurator.getLastActuationsPullTime(function(lastPullTimestamp) {
        if(lastPullTimestamp) {
            me.logger.info("Pulling actuations from last pull time: " + new Date(lastPullTimestamp));
            data.from = lastPullTimestamp;
        } else {
            me.logger.info("Pulling actuations from last 24 hours");
        }
        me.proxy.pullActuations(data, function (result) {
            if (result && result.length) {
                me.logger.info("Running " + result.length +" actuations.");
                var udp = udpServer.singleton(conf.listeners.udp_port, me.logger);
                var receiverInfo = {
                    port: conf.receivers.udp_port,
                    address: conf.receivers.udp_address
                };
                for (var i = 0; i < result.length; i++ ){
                    var actuation = result[i];
                    me.logger.debug('Received actuation content: ' + JSON.stringify(actuation));
                    var comp = me.store.byCid(actuation.componentId);
                    var udpMessage = {
                        component: comp.name,
                        command: actuation.command,
                        argv: actuation.params
                    };
                    me.logger.info("Sending actuation: " + JSON.stringify(udpMessage));
                    udp.send(receiverInfo, udpMessage);
                }
                configurator.setLastActuationsPullTime(Date.now());
                udp.close();
            }
        });
    });
};

IoTKitCloud.prototype.getActualTime = function (callback) {
    var me = this;
    me.proxy.getActualTime(function (result) {
        me.logger.debug("Response ", result);
        callback(result);
    });
};

exports.init = function(logger, deviceId) {
    return new IoTKitCloud(logger, deviceId);
};
