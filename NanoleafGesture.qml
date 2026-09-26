// Nanoleaf Gesture -- SignalRGB add-on settings page.
// Copyright (c) 2026 Jonathan Adam. MIT License (see LICENSE).
//
// Lists discovered controllers (service.controllers), lets the user add one by IP
// (discovery.forceDiscover) and pair it (discovery.link -> POST /api/v1/new).
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root
    anchors.fill: parent

    readonly property color cardColor: "#101820"
    readonly property color cardBorder: "#26323d"
    readonly property color accent: "#3d7ea6"
    readonly property color danger: "#7a2e2e"
    readonly property color textMain: "#ffffff"
    readonly property color textDim: "#a9b4be"

    component ActionButton: Button {
        id: btn
        property color fill: root.accent
        implicitHeight: 34
        implicitWidth: Math.max(96, contentItem.implicitWidth + 24)
        contentItem: Text {
            text: btn.text
            color: root.textMain
            font.pixelSize: 13
            font.bold: true
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
        background: Rectangle {
            radius: 4
            color: btn.enabled ? (btn.hovered ? Qt.darker(btn.fill, 1.3) : btn.fill) : "#3a3f44"
        }
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 10

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: header.implicitHeight + 24
            radius: 8
            color: root.cardColor
            border.color: root.cardBorder

            ColumnLayout {
                id: header
                anchors.fill: parent
                anchors.margins: 12
                spacing: 6

                Text {
                    text: "Nanoleaf Gesture"
                    color: root.textMain
                    font.pixelSize: 22
                    font.bold: true
                }

                Text {
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    color: root.textDim
                    font.pixelSize: 13
                    text: "Controllers are found automatically over mDNS. To link one, hold its power button for 5-7 seconds until the lights flash, then press Link within 30 seconds. If a controller does not appear, type its IP address."
                }

                RowLayout {
                    spacing: 8

                    TextField {
                        id: ipField
                        Layout.preferredWidth: 220
                        placeholderText: "192.168.1.20"
                        validator: RegularExpressionValidator {
                            regularExpression: /^[0-9.]{0,15}$/
                        }
                        onAccepted: addButton.clicked()
                    }

                    ActionButton {
                        id: addButton
                        text: "Add IP"
                        onClicked: {
                            discovery.forceDiscover(ipField.text)
                            ipField.text = ""
                        }
                    }
                }
            }
        }

        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

            ColumnLayout {
                width: root.width
                spacing: 8

                Repeater {
                    model: service.controllers

                    delegate: Rectangle {
                        id: card
                        property var ctrl: model.modelData.obj

                        Layout.fillWidth: true
                        Layout.preferredHeight: body.implicitHeight + 24
                        radius: 8
                        color: root.cardColor
                        border.color: root.cardBorder

                        ColumnLayout {
                            id: body
                            anchors.fill: parent
                            anchors.margins: 12
                            spacing: 4

                            Text {
                                text: card.ctrl.name
                                color: root.textMain
                                font.pixelSize: 17
                                font.bold: true
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }

                            Text {
                                Layout.fillWidth: true
                                color: root.textDim
                                font.pixelSize: 12
                                elide: Text.ElideRight
                                text: (card.ctrl.model ? card.ctrl.model + "   " : "")
                                      + "IP " + card.ctrl.ip
                                      + (card.ctrl.firmwareVersion ? "   fw " + card.ctrl.firmwareVersion : "")
                            }

                            Text {
                                Layout.fillWidth: true
                                wrapMode: Text.WordWrap
                                color: card.ctrl.paired ? "#7fd18b" : "#e0c070"
                                font.pixelSize: 12
                                text: card.ctrl.statusText
                            }

                            RowLayout {
                                spacing: 8

                                ActionButton {
                                    text: card.ctrl.paired ? "Unlink" : (card.ctrl.busy ? "Working..." : "Link")
                                    enabled: !card.ctrl.busy
                                    fill: card.ctrl.paired ? "#44525e" : root.accent
                                    onClicked: card.ctrl.paired ? discovery.unlink(card.ctrl) : discovery.link(card.ctrl)
                                }

                                ActionButton {
                                    text: "Forget"
                                    fill: root.danger
                                    onClicked: discovery.remove(card.ctrl)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
